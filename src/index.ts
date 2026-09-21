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

import { summarizeSessionLog, type SessionLogLike } from './agent/context-info.js'
import { DEFAULT_SYSTEM_PROMPT } from './agent/prompt.js'
import { SessionManager } from './agent/sessions.js'
import { createAgentTools } from './agent/tools.js'
import { Config } from './core/config.js'
import { describeError } from './core/errors.js'
import { formatTime } from './core/time.js'
import { buildIdReply, decideAccess, ID_COMMAND, isIdCommand } from './qq/access.js'
import { ApprovalChannel, type ApprovalContext } from './qq/approval.js'
import { YashiroGateway } from './qq/gateway.js'
import { buildUserText } from './qq/message-text.js'
import {
  buildContextText,
  buildCurrentText,
  buildListText,
  buildNewSessionText,
  buildSwitchErrorText,
  buildSwitchOkText,
  buildUsageText,
  isSessionOperator,
  matchSession,
  NO_SESSION_TEXT,
  parseSessionCommand,
  SESSIONS_PER_PAGE,
  shortSessionId,
  type SessionCommand,
  type SessionCommandContext,
  type SessionLine,
} from './qq/session-commands.js'
import { defaultHistoryDbPath, HistoryStore, type SessionBinding, type StoredMessage } from './store.js'

export const name = 'dsh-yashiro'

/**
 * 依赖的 cordis 服务：agent 注册表、默认模型、工具与系统提示词注册表、会话标题。
 *
 * sessionTitle 由 dsh-base 提供，所以实际上一定在；列进来是为了拿到类型。
 */
export const inject = ['agents', 'agentDefaultModel', 'tools', 'systemPrompt', 'sessionTitle']

export { Config }
export type { Config as YashiroConfig } from './core/config.js'

const PLUGIN_ID = 'dsh-yashiro'

/** 每个会话记住多少条已处理的消息 ID；超出就丢最早的 */
const DEDUPE_WINDOW = 200

/** ctx.sessionTitle（@deepseek-ai/dsh-session-title）里用到的最小面 */
interface SessionTitleServiceLike {
  rename(session: unknown, title: string): unknown
}

/** Agent 上标题需要用到的那两个字段 */
interface AgentLike {
  id: unknown
  session: unknown
}

export function apply(ctx: Context, config: Config): void {
  const store = new HistoryStore(config.historyDbPath?.trim() || defaultHistoryDbPath())

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
    approvers: config.approvers,
    timeoutMs: config.approvalTimeoutSeconds * 1000,
    send: (target, text, keyboard) => gateway.sendCard(target.scope, target.peerId, text, keyboard),
    findTarget: (sessionId) => sessions.findTarget(sessionId),
    currentSessionOf: (scope, peerId) => store.getCurrentSession(config.appId, scope, peerId)?.sessionId,
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
        text: DEFAULT_SYSTEM_PROMPT,
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

  /** 当前会话指针是持久化的，所以重启后 @ 还会落到同一条会话上 */
  function currentOf(scope: 'group' | 'c2c', peerId: string): SessionBinding | undefined {
    return store.getCurrentSession(config.appId, scope, peerId)
  }

  /**
   * 折叠这条会话的日志，拼出 `/context` 的回复。
   *
   * 连不上会话（比如文件被删了）不当成致命错误：回一句说明，当前会话指针不动。
   */
  async function buildContextReply(
    scope: 'group' | 'c2c',
    peerId: string,
    sessionId: string,
  ): Promise<string> {
    const agent = await sessions.select(scope, peerId, sessionId, buildSetup(scope, peerId))
    if (agent === undefined) {
      return `会话 ${shortSessionId(sessionId)} 连不上（会话文件可能被删了）。`
    }
    try {
      const summary = summarizeSessionLog((agent as unknown as { session: SessionLogLike }).session)
      return buildContextText({ sessionId, ...summary }, formatTime)
    } catch (err) {
      logger.warn(`[dsh-yashiro] 读取会话日志失败：${describeError(err)}`)
      return '读这条会话的日志失败，详情见插件日志。'
    }
  }

  /** 把一个绑定行翻成展示用的会话行 */
  function toLine(session: SessionBinding, current: SessionBinding | undefined): SessionLine {
    return {
      id: session.sessionId,
      epoch: session.epoch,
      updatedAt: session.updatedAt,
      current: current?.sessionId === session.sessionId,
    }
  }

  /** 这个群/单聊的全部会话，按最近使用倒序，标出哪条是当前 */
  function sessionLines(scope: 'group' | 'c2c', peerId: string): SessionLine[] {
    const current = currentOf(scope, peerId)
    return store
      .listSessions(config.appId, scope, peerId, 1, Number.MAX_SAFE_INTEGER)
      .sessions.map((s) => toLine(s, current))
  }

  function sessionContext(scope: 'group' | 'c2c', peerId: string): SessionCommandContext {
    const lines = sessionLines(scope, peerId)
    const current = lines.find((line) => line.current)
    return { ...(current ? { current } : {}), sessions: lines, total: lines.length, formatTime }
  }

  /**
   * 会话指令的统一出口，调用方拿到 true 就结束这一条消息的处理。
   *
   * 这些指令会改「这个群正在用哪条会话」，所以限审批名单 —— 否则群里任何人都能
   * 把会话换成自己的。被拒时明确回一句，不静默丢弃。
   */
  async function handleSessionCommand(msg: StoredMessage, command: SessionCommand): Promise<true> {
    const scope = msg.scope
    const peerId = msg.peerId

    if (!isSessionOperator(msg.senderId, config.approvers)) {
      logger.info(`[dsh-yashiro] 会话指令被非名单内的人触发：${msg.senderId}`)
      await reply('只有审批名单里的人能用会话指令。')
      return true
    }

    if (command.kind === 'usage') {
      await reply(buildUsageText(command.command))
      return true
    }

    if (command.kind === 'current') {
      await reply(buildCurrentText(sessionContext(scope, peerId)))
      return true
    }

    if (command.kind === 'context') {
      const current = currentOf(scope, peerId)
      if (current === undefined) {
        await reply(NO_SESSION_TEXT)
        return true
      }
      await reply(await buildContextReply(scope, peerId, current.sessionId))
      return true
    }

    if (command.kind === 'list') {
      const lines = sessionLines(scope, peerId)
      const start = (command.page - 1) * SESSIONS_PER_PAGE
      const current = lines.find((line) => line.current)
      await reply(
        buildListText(
          {
            ...(current ? { current } : {}),
            sessions: lines.slice(start, start + SESSIONS_PER_PAGE),
            total: lines.length,
            formatTime,
          },
          command.page,
        ),
      )
      return true
    }

    if (command.kind === 'new') {
      const epoch = store.nextEpoch(config.appId, scope, peerId)
      try {
        // 先建会话再落绑定：建失败就什么都不落，当前会话与绑定保持原样
        const agent = await sessions.create(scope, peerId, epoch, buildSetup(scope, peerId))
        titleSession(agent)
        const binding = store.createSession(config.appId, scope, peerId, String(agent.id))
        logger.info(`[dsh-yashiro] 已新建会话：${shortSessionId(String(agent.id))} peer=${peerId}`)
        await reply(buildNewSessionText(toLine(binding, binding), formatTime))
      } catch (err) {
        logger.error(`[dsh-yashiro] 新建会话失败: ${describeError(err)}`)
        await reply('新建会话失败，当前会话没有变化。详情见插件日志。')
      }
      return true
    }

    // /switch：只认自己这个群里的会话；唯一才切，不猜
    const lines = sessionLines(scope, peerId)
    const matches = matchSession(command.id, lines)
    const target = matches.length === 1 ? matches[0] : undefined
    if (target === undefined) {
      await reply(buildSwitchErrorText(command.id, matches))
      return true
    }

    const agent = await sessions.select(scope, peerId, target.id, buildSetup(scope, peerId))
    if (agent === undefined) {
      await reply(`会话 ${shortSessionId(target.id)} 连不上（会话文件可能被删了），当前会话没有变化。`)
      return true
    }
    titleSession(agent)
    store.setCurrentSession(config.appId, scope, peerId, target.epoch)
    logger.info(`[dsh-yashiro] 已切换会话：${shortSessionId(target.id)} peer=${peerId}`)
    await reply(buildSwitchOkText(target, formatTime))
    return true

    async function reply(text: string): Promise<void> {
      try {
        await gateway.send(scope, peerId, text)
        recordOutbound(scope, peerId, text)
      } catch (err) {
        logger.error(`[dsh-yashiro] 发送会话指令回复失败: ${describeError(err)}`)
      }
    }
  }

  /**
   * 给会话起个名字，让它在 web 侧边栏里认得出是哪条。
   *
   * 用 8 位短 ID，和群里 /list、/current 显示的是同一个值。不设的话侧边栏会退回
   * 工作目录名（所有会话都长一样）。
   *
   * rename 写入的标题 source 是 `user`，这个标记会连带禁掉首条消息触发的 LLM 自动
   * 标题 —— 否则我们设的名字会在 agent 第一次回话时被顶掉。
   */
  function titleSession(agent: AgentLike): void {
    const titles = ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (titles === undefined) {
      logger.debug('[dsh-yashiro] 没有 sessionTitle 服务，跳过设置会话标题')
      return
    }
    try {
      titles.rename(agent.session, shortSessionId(String(agent.id)))
    } catch (err) {
      logger.warn(`[dsh-yashiro] 设置会话标题失败（不影响对话）：${describeError(err)}`)
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

    const sessionCommand = parseSessionCommand(msg.content)
    if (sessionCommand !== undefined) {
      await handleSessionCommand(msg, sessionCommand)
      return
    }

    // 没有会话就不建：明确让用户 /new，避免一个 @ 就悄悄开出一条空会话
    const current = currentOf(msg.scope, msg.peerId)
    if (current === undefined) {
      logger.info(`[dsh-yashiro] 无会话，已提示 ${msg.scope} ${msg.peerId} 用 /new`)
      try {
        await gateway.send(msg.scope, msg.peerId, NO_SESSION_TEXT)
        recordOutbound(msg.scope, msg.peerId, NO_SESSION_TEXT)
      } catch (err) {
        logger.error(`[dsh-yashiro] 发送「无会话」提示失败: ${describeError(err)}`)
      }
      return
    }

    // 去重与「上次开口」都按会话记：/new 之后是全新上下文，不该继承旧会话的状态
    const dedupeKey = current.sessionId
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
      logger.debug(`[trace] 准备连到会话 session=${shortSessionId(current.sessionId)} peer=${msg.peerId}`)
      const agent = await sessions.select(
        msg.scope,
        msg.peerId,
        current.sessionId,
        buildSetup(msg.scope, msg.peerId),
      )
      if (agent === undefined) {
        logger.error(`[dsh-yashiro] 会话连不上：${shortSessionId(current.sessionId)}`)
        const notice = `当前会话（${shortSessionId(current.sessionId)}）连不上，用 /new 或 /switch 换一条。`
        await gateway.send(msg.scope, msg.peerId, notice)
        recordOutbound(msg.scope, msg.peerId, notice)
        return
      }
      logger.debug(`[trace] 会话就绪 session=${String(agent.id)}，准备投递`)
      const message = createUserMessage({
        content: [{ type: 'text', text: buildUserText(msg, { newSinceLastWake }) }],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      })
      // queue 是等当前回合结束再开新回合；steer 在当前回合的下一个 step 边界就注入
      if (config.busyDelivery === 'queue') agent.followup(message)
      else agent.steer(message)
      logger.debug(`[trace] ${config.busyDelivery} 已提交`)
      store.touchSession(config.appId, msg.scope, msg.peerId, current.epoch)
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
