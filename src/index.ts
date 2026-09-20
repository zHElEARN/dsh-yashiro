/**
 * dsh-yashiro：把 QQ 群消息接进 dsh agent 回合，并把 qqbot_history / qqbot_send
 * 两个工具挂给这个会话专属的 agent。
 *
 * 所有群消息入库；只有 @ 机器人的消息会唤醒 agent，回复完全由它调 qqbot_send 完成。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { DEFAULT_SYSTEM_PROMPT } from './agent/prompt.js'
import { SessionManager } from './agent/sessions.js'
import { createAgentTools } from './agent/tools.js'
import { Config } from './core/config.js'
import { describeError } from './core/errors.js'
import { buildIdReply, decideAccess, ID_COMMAND, isIdCommand } from './qq/access.js'
import { ApprovalChannel, type ApprovalContext } from './qq/approval.js'
import { YashiroGateway } from './qq/gateway.js'
import { buildUserText } from './qq/message-text.js'
import { defaultHistoryDbPath, HistoryStore, type StoredMessage } from './store.js'

export const name = 'dsh-yashiro'

/** 依赖的 cordis 服务：agent 注册表、默认模型、工具注册表、系统提示词注册表 */
export const inject = ['agents', 'agentDefaultModel', 'tools', 'systemPrompt']

export { Config }
export type { Config as YashiroConfig } from './core/config.js'

const PLUGIN_ID = 'dsh-yashiro'

/** 每个会话记住多少条已处理的消息 ID；超出就丢最早的 */
const DEDUPE_WINDOW = 200

export function apply(ctx: Context, config: Config): void {
  const store = new HistoryStore(config.historyDbPath?.trim() || defaultHistoryDbPath())
  const promptTemplate = config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT

  /** 上次唤醒 agent 的时间（每个会话），用来告诉它「你不在的时候群里又聊了多少」 */
  const lastWakeAt = new Map<string, number>()
  /** 已处理过的消息 ID（每个会话），防止平台重推导致重复唤醒 */
  const seenMessages = new Map<string, Set<string>>()

  // headless profile 下 ctx.logger 没有可见出口，所以在历史库同目录再写一份 plugin.log
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
      /* 日志写不进去也不能影响主流程 */
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

  const sessions = new SessionManager(ctx, config.appId, config.cwd?.trim() || process.cwd(), logger)

  // 网关与审批通道互相引用，先声明类型后赋值，避免 TS 的类型推断绕成环
  let gateway: YashiroGateway

  const approval = new ApprovalChannel({
    appId: config.appId,
    approvers: config.approvers,
    timeoutMs: config.approvalTimeoutSeconds * 1000,
    send: (target, text, keyboard) => gateway.sendCard(target.scope, target.peerId, text, keyboard),
    findTarget: (sessionId) => sessions.findTarget(sessionId),
    logger,
  })

  gateway = new YashiroGateway(
    config,
    {
      onMessage: (msg) => {
        void handleMessage(msg)
      },
      onReady: () => {},
      onError: () => {},
      onInteraction: (event) => approval.handleInteraction(event),
    },
    logger,
  )
  approval.install(ctx as unknown as ApprovalContext)

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
        text: promptTemplate,
      })
    }
  }

  function recordOutbound(scope: 'group' | 'c2c', peerId: string, text: string): void {
    try {
      store.appendOutbound(config.appId, scope, peerId, text)
    } catch (err) {
      logger.error(`[dsh-yashiro] 记录出站消息失败: ${describeError(err)}`)
    }
  }

  async function handleMessage(msg: StoredMessage): Promise<void> {
    // 入库先于访问控制：白名单只决定「要不要唤醒 agent」，不决定「要不要记录」
    try {
      store.append(msg)
    } catch (err) {
      logger.error(`[dsh-yashiro] 写入历史库失败: ${describeError(err)}`)
    }

    // `/id` 绕过访问控制：不知道 group openid 就没法配白名单，这个自举口子必须留着
    if (isIdCommand(msg.content, msg.mentionsBot)) {
      try {
        const reply = buildIdReply(msg)
        await gateway.send(msg.scope, msg.peerId, reply)
        recordOutbound(msg.scope, msg.peerId, reply)
        logger.info(`[dsh-yashiro] 已响应 ${ID_COMMAND}：${msg.scope} ${msg.peerId}`)
      } catch (err) {
        logger.error(`[dsh-yashiro] 回复 ${ID_COMMAND} 失败: ${describeError(err)}`)
      }
      return
    }

    const access = decideAccess(msg, config)
    if (access.action === 'deny-peer') {
      logger.debug(`[dsh-yashiro] 会话未放行（${access.reason}）：${msg.scope} ${msg.peerId}`)
      return
    }

    if (!msg.mentionsBot) {
      logger.debug(`[trace] 非 @ 消息，仅入库: ${JSON.stringify(msg.content.slice(0, 40))}`)
      return
    }

    if (access.action === 'deny-sender') {
      logger.info(`[dsh-yashiro] 发送者在黑名单，跳过唤醒：${msg.senderId}`)
      return
    }

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

    // 首次唤醒不报数，否则 agent 一上来就被告知「有几千条新消息」
    const previousWake = lastWakeAt.get(dedupeKey)
    let newSinceLastWake: number | undefined
    if (config.announceNewMessageCount && previousWake !== undefined) {
      try {
        newSinceLastWake = store.countSince(config.appId, msg.peerId, previousWake, true)
      } catch {
        newSinceLastWake = undefined
      }
    }

    try {
      logger.debug(`[trace] 准备建立/复用会话 peer=${msg.peerId}`)
      const agent = await sessions.getOrCreate(msg.scope, msg.peerId, buildSetup(msg.scope, msg.peerId))
      logger.debug(`[trace] 会话就绪 session=${String(agent.id)}，准备投递`)
      const message = createUserMessage({
        content: [{ type: 'text', text: buildUserText(msg, { newSinceLastWake }) }],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      })
      // queue 是等当前回合结束再开新回合；steer 在当前回合的下一个 step 边界就注入
      if (config.busyDelivery === 'queue') agent.followup(message)
      else agent.steer(message)
      logger.debug(`[trace] ${config.busyDelivery} 已提交`)
      lastWakeAt.set(dedupeKey, Date.parse(msg.timestamp) || Date.now())
      logger.info(
        `[dsh-yashiro] 已唤醒 agent：session=${String(agent.id).slice(0, 12)}… peer=${msg.peerId}`,
      )
    } catch (err) {
      logger.error(`[dsh-yashiro] 唤醒 agent 失败: ${describeError(err)}`)
    }
  }

  gateway.start()
  logger.info(
    `[dsh-yashiro] 已启动（appId=${config.appId} 沙箱=${config.sandbox} 库=${config.historyDbPath?.trim() || defaultHistoryDbPath()}）`,
  )

  // effect 返回的函数在本插件 fiber 销毁时执行
  ctx.effect(() => () => {
    logger.info('[dsh-yashiro] 正在关闭…')
    approval.cancelAll()
    gateway.stop()
    void sessions.disposeAll()
    store.close()
  })
}
