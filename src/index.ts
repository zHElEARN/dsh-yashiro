/**
 * dsh-yashiro —— QQ 群机器人通道插件（dsh bundle 入口）。
 *
 * 架构一句话：**QQ 只是感官和发声器官，dsh agent 才是主体。**
 *
 *   QQ 消息 ──▶ 入库（全部） ──┬─ 没 @ 机器人 ──▶ 到此为止
 *                             └─ @ 了机器人 ──▶ 唤醒 agent 回合
 *
 *   agent ──▶ qqbot_history（自己查群里聊过什么）
 *         └─▶ qqbot_send（唯一的发声通道）
 *
 * 关键取舍（都是和用户确认过的）：
 * - 插件**不接管 agent 的输出**：回复完全由 agent 调 qqbot_send 完成，
 *   思考过程和工具调用一律不同步到 QQ。
 * - 非 @ 消息**只入库、不进上下文**，agent 需要时自己查。
 * - 一个 QQ 会话（群/单聊）= 一条 dsh 会话，SessionId 确定性派生，可跨重启恢复。
 * - v1 不做斜杠命令、不做上下文压缩、不做多会话切换。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { Config } from './config.js'
import { YashiroGateway } from './gateway.js'
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from './prompt.js'
import { SessionManager } from './sessions.js'
import { defaultHistoryDbPath, HistoryStore, type StoredMessage } from './store.js'
import { createAgentTools } from './tools.js'

export const name = 'dsh-yashiro'

/** 依赖的 cordis 服务：agent 注册表、工具注册表、系统提示词注册表 */
export const inject = ['agents', 'agentDefaultModel', 'tools', 'systemPrompt']

export { Config }
export type { Config as YashiroConfig } from './config.js'

/** 唤醒 agent 时，作为 user 消息来源的插件标识 */
const PLUGIN_ID = 'dsh-yashiro'

/** 同一会话里最多记多少个已处理的消息 ID，用于去重 */
const DEDUPE_WINDOW = 200

export function apply(ctx: Context, config: Config): void {
  const store = new HistoryStore(config.historyDbPath?.trim() || defaultHistoryDbPath())
  const promptTemplate = config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
  const sessions = new SessionManager(ctx, config.appId, config.cwd?.trim() || process.cwd())

  /** 上次唤醒 agent 的时间（每个会话），用来告诉它「你不在的时候群里又聊了多少」 */
  const lastWakeAt = new Map<string, number>()
  /** 已处理过的消息 ID（每个会话），防止平台重推导致重复唤醒 */
  const seenMessages = new Map<string, Set<string>>()

  // headless profile 下 ctx.logger 没有可见出口，所以自己再写一份文件日志，
  // 方便排查（路径：历史库同目录下的 plugin.log）
  const logFile = join(dirname(store.path), 'plugin.log')
  try {
    mkdirSync(dirname(logFile), { recursive: true })
  } catch {
    /* 目录已存在 */
  }
  const writeLog = (level: string, message: string): void => {
    if (level === 'DEBUG' && !config.debug) return
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${message}\n`)
    } catch {
      /* 写不进去就算了，不能因为日志把主流程搞挂 */
    }
  }
  const logger = {
    info: (m: string) => {
      writeLog('INFO', m)
      ctx.logger.info(m)
    },
    warn: (m: string) => {
      writeLog('WARN', m)
      ctx.logger.warn(m)
    },
    error: (m: string) => {
      writeLog('ERROR', m)
      ctx.logger.error(m)
    },
    debug: (m: string) => writeLog('DEBUG', m),
  }

  const gateway = new YashiroGateway(
    config,
    {
      onMessage: (msg) => {
        void handleMessage(msg)
      },
      onReady: () => {},
      onError: () => {},
    },
    logger,
  )

  /** 建立这个 QQ 会话专属的 agent 世界：两个工具 + 一段系统提示词 */
  function buildSetup(scope: 'group' | 'c2c', peerId: string): AgentSetup {
    return (agentCtx) => {
      const deps = { store, gateway, config, scope, peerId }
      for (const tool of createAgentTools(deps)) {
        agentCtx.tools.register(tool)
      }
      agentCtx.systemPrompt.section({
        name: 'dsh-yashiro:channel',
        order: 90,
        text: renderSystemPrompt(promptTemplate, { scope, peerId }),
      })
    }
  }

  /** 组装这条 @ 消息送进 agent 的正文 */
  function buildUserText(msg: StoredMessage, newSinceLastWake: number | undefined): string {
    const where = msg.scope === 'group' ? '群里' : '单聊里'
    const who = msg.senderName ?? msg.senderId
    const lines = [`${who} 在${where} @ 了你：`, '', msg.content]
    if (msg.quotedContent) {
      lines.push('', `（引用了：${msg.quotedContent}）`)
    }
    if (newSinceLastWake !== undefined && newSinceLastWake > 0) {
      lines.push('', `（自你上次开口以来，群里还有 ${newSinceLastWake} 条新消息。需要的话用 qqbot_history 查。）`)
    }
    return lines.join('\n')
  }

  async function handleMessage(msg: StoredMessage): Promise<void> {
    // 1) 无论 @ 与否，全部进历史库
    try {
      store.append(msg)
    } catch (err) {
      logger.error(`[dsh-yashiro] 写入历史库失败: ${describe(err)}`)
    }

    // 2) 群白名单
    if (msg.scope === 'group' && config.allowedGroups.length > 0 && !config.allowedGroups.includes(msg.peerId)) {
      return
    }

    // 3) 没 @ 机器人 → 只入库，不打扰 agent
    if (!msg.mentionsBot) {
      logger.debug(`[trace] 非 @ 消息，仅入库: ${JSON.stringify(msg.content.slice(0, 40))}`)
      return
    }

    // 4) 去重
    const dedupeKey = `${msg.scope}:${msg.peerId}`
    let seen = seenMessages.get(dedupeKey)
    if (!seen) {
      seen = new Set()
      seenMessages.set(dedupeKey, seen)
    }
    if (seen.has(msg.messageId)) return
    seen.add(msg.messageId)
    if (seen.size > DEDUPE_WINDOW) {
      const first = seen.values().next().value
      if (first !== undefined) seen.delete(first)
    }

    // 5) 统计「你不在的时候群里聊了多少」（首次唤醒不报，免得上来就是几千条）
    const previousWake = lastWakeAt.get(dedupeKey)
    let newSinceLastWake: number | undefined
    if (config.announceNewMessageCount && previousWake !== undefined) {
      try {
        newSinceLastWake = store.countSince(config.appId, msg.peerId, previousWake, true)
      } catch {
        newSinceLastWake = undefined
      }
    }

    // 6) 唤醒 agent
    try {
      logger.debug(`[trace] 准备建立/复用会话 peer=${msg.peerId}`)
      const agent = await sessions.getOrCreate(msg.scope, msg.peerId, buildSetup(msg.scope, msg.peerId))
      logger.debug(`[trace] 会话就绪 session=${String(agent.id)}，准备 followup`)
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: buildUserText(msg, newSinceLastWake) }],
          source: { kind: 'plugin', plugin: PLUGIN_ID },
        }),
      )
      logger.debug('[trace] followup 已提交')
      lastWakeAt.set(dedupeKey, Date.parse(msg.timestamp) || Date.now())
      logger.info(
        `[dsh-yashiro] 已唤醒 agent：session=${String(agent.id).slice(0, 12)}… peer=${msg.peerId}`,
      )
    } catch (err) {
      logger.error(`[dsh-yashiro] 唤醒 agent 失败: ${describe(err)}`)
    }
  }

  gateway.start()
  logger.info(
    `[dsh-yashiro] 已启动（appId=${config.appId} 沙箱=${config.sandbox} 库=${config.historyDbPath?.trim() || defaultHistoryDbPath()}）`,
  )

  // cordis 的生命周期钩子：effect 返回的函数在本插件 fiber 销毁时执行
  ctx.effect(() => () => {
    logger.info('[dsh-yashiro] 正在关闭…')
    gateway.stop()
    void sessions.disposeAll()
    store.close()
  })
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ''}`
  return String(err)
}
