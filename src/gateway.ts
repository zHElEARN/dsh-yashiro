/**
 * QQ 平台网关：负责连接、事件归一化、发送。
 *
 * 事件形态（2026-09-20 实测，官方"接收所有消息"模式下）：
 *   - 群里所有消息都以 `GROUP_MESSAGE_CREATE` 推送，**包括 @ 机器人的那些**。
 *   - 是否 @ 了机器人看 `mentions[].is_you`，而不是看事件名。
 *   - `content` 里的 @ 标记是 `<@OPENID>` 形式，**不会被平台剥掉**，得自己剥。
 *   - 引用消息的 `msg_elements[0].content` 是被引用那条的正文（聊天记录会被平台
 *     展开成一整段文本）。
 *
 * 所以本插件同时兼容两种事件名：没开全量模式的群只会推 GROUP_AT_MESSAGE_CREATE。
 */
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import type { InboundMessage } from '@tencent-connect/qqbot-nodejs'
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs'
import { FULL_INTENTS } from '@tencent-connect/qqbot-nodejs/protocol'

import type { Config } from './config.js'
import type { AttachmentInfo, StoredMessage } from './store.js'

/** 群全量消息的 intent 位。官方文档写 1<<25 就够，实测需要额外带上这一位。 */
const GROUP_MESSAGE_INTENT = 1 << 24

const SANDBOX_BASE_URL = 'https://sandbox.api.sgroup.qq.com'

/** `mentions` 数组元素（只声明我们用得到的字段） */
interface MentionLike {
  is_you?: boolean
  bot?: boolean
  id?: string
  username?: string
}

/** 平台给的原始附件结构 */
interface RawAttachmentLike {
  content_type?: string
  url?: string
  filename?: string
  size?: number
  width?: number
  height?: number
  asr_refer_text?: string
  voice_wav_url?: string
}

/** `msg_elements` 数组元素 */
interface MsgElementLike {
  content?: string
  message_type?: number
  attachments?: RawAttachmentLike[]
}

/** 从 content 里剥掉 `<@OPENID>` / `<@!OPENID>` 标记 */
export function stripMentionMarkers(content: string): string {
  return content.replace(/<@!?[0-9A-Za-z_-]+>/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

/** 这条消息是否 @ 了机器人 */
export function isBotMentioned(msg: InboundMessage): boolean {
  // 老形态：平台直接推的 @ 事件，必然 @ 了机器人
  if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || msg.rawEventType === 'AT_MESSAGE_CREATE') {
    return true
  }
  const mentions = (msg as unknown as { mentions?: MentionLike[] }).mentions
  if (Array.isArray(mentions)) {
    return mentions.some((m) => m?.is_you === true)
  }
  return false
}

/** 原始附件 → 我们的附件结构（只搬运元信息，不下载） */
function toAttachmentInfo(raw: RawAttachmentLike, from: 'current' | 'quoted'): AttachmentInfo {
  return {
    contentType: raw.content_type ? String(raw.content_type) : 'unknown',
    from,
    ...(raw.url ? { url: String(raw.url) } : {}),
    ...(raw.filename ? { filename: String(raw.filename) } : {}),
    ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
    ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
    ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
    ...(raw.asr_refer_text ? { asrText: String(raw.asr_refer_text) } : {}),
    ...(raw.voice_wav_url ? { voiceWavUrl: String(raw.voice_wav_url) } : {}),
  }
}

/** 把 SDK 归一化后的入站消息转成我们要存的一条记录 */
export function normalizeInbound(appId: string, msg: InboundMessage): StoredMessage | null {
  const scope: 'group' | 'c2c' = msg.kind === 'c2c' ? 'c2c' : 'group'
  if (msg.kind !== 'group' && msg.kind !== 'c2c') return null

  const peerId = scope === 'group' ? (msg.groupOpenid ?? '') : msg.senderId
  if (!peerId) return null

  const elements = (msg as unknown as { msgElements?: MsgElementLike[] }).msgElements
  const quotedElement = elements?.[0]
  const quoted = quotedElement?.content

  // 附件有两个来源，都要带上：
  //   - 当前这条消息自带的（msg.attachments）
  //   - 被引用那条消息带的（msg.msgElements[0].attachments）
  // 引用一张纯图片时，被引用消息没有文字，附件全在后者 —— 这正是之前漏掉的那条路径。
  const ownAttachments = (msg.attachments ?? []) as unknown as RawAttachmentLike[]
  const quotedAttachments = quotedElement?.attachments ?? []
  const attachments: AttachmentInfo[] = [
    ...ownAttachments.map((a) => toAttachmentInfo(a, 'current')),
    ...quotedAttachments.map((a) => toAttachmentInfo(a, 'quoted')),
  ]

  return {
    appId,
    scope,
    peerId,
    messageId: msg.messageId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    content: stripMentionMarkers(msg.content ?? ''),
    mentionsBot: isBotMentioned(msg),
    quotedContent: quoted ? stripMentionMarkers(quoted) : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    rawEventType: msg.rawEventType,
    timestamp: msg.timestamp,
  }
}

export interface GatewayHandlers {
  /** 收到一条归一化后的消息（已入库之前调用） */
  onMessage(msg: StoredMessage): void
  onReady(): void
  onError(err: unknown): void
  /**
   * 审批按钮被点击（INTERACTION_CREATE）。返回要回给平台的 ack code
   * （0 成功 / 4 没权限）；返回 undefined 表示不是本插件的按钮。
   */
  onInteraction?(event: InteractionEvent): number | undefined
}

/** 薄封装：QQBot 生命周期 + 发送 */
export class YashiroGateway {
  private readonly bot: QQBot
  private readonly log: (msg: string) => void
  private started = false

  constructor(
    private readonly config: Config,
    handlers: GatewayHandlers,
    logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
  ) {
    const log = (msg: string) => {
      if (config.debug) logger.info(msg)
    }
    this.log = log

    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: config.sandbox ? SANDBOX_BASE_URL : undefined,
      intents: FULL_INTENTS | GROUP_MESSAGE_INTENT,
      markdownSupport: true,
      logger: {
        debug: (m?: unknown) => log(`[qqbot:debug] ${stringify(m)}`),
        info: (m?: unknown) => log(`[qqbot] ${stringify(m)}`),
        warn: (m?: unknown) => logger.warn(`[dsh-yashiro] ${stringify(m)}`),
        error: (m?: unknown) => logger.error(`[dsh-yashiro] ${stringify(m)}`),
      },
    })

    this.bot.on('ready', () => {
      logger.info('[dsh-yashiro] QQ WebSocket 已连接（READY）')
      handlers.onReady()
    })

    this.bot.on('resumed', () => log('[dsh-yashiro] QQ WebSocket 会话已恢复（RESUMED）'))

    this.bot.on('error', (err: unknown) => {
      logger.error(`[dsh-yashiro] QQ 连接错误: ${stringify(err)}`)
      handlers.onError(err)
    })

    this.bot.on('message', (_ctx: unknown, msg: InboundMessage) => {
      try {
        const normalized = normalizeInbound(config.appId, msg)
        if (!normalized) return
        log(
          `[dsh-yashiro] 收到消息 type=${normalized.rawEventType} peer=${normalized.peerId} ` +
            `from=${normalized.senderName ?? normalized.senderId} mention=${normalized.mentionsBot} ` +
            `content=${JSON.stringify(normalized.content.slice(0, 80))}`,
        )
        handlers.onMessage(normalized)
      } catch (err) {
        logger.error(`[dsh-yashiro] 处理入站消息失败: ${stringify(err)}`)
      }
    })

    // 审批按钮点击：INTERACTION_CREATE 经 WebSocket 推过来，不需要回调服务器。
    // 必须回执，否则客户端按钮一直转圈；不是本插件的按钮回 3（重复操作）。
    this.bot.on('interaction', (_ctx: unknown, event: InteractionEvent) => {
      let code = 3
      try {
        code = handlers.onInteraction?.(event) ?? 3
      } catch (err) {
        logger.error(`[dsh-yashiro] 处理按钮点击失败: ${stringify(err)}`)
      }
      void this.bot.acknowledgeInteraction(event.id, code).catch((err: unknown) => {
        logger.error(`[dsh-yashiro] 按钮点击回执失败: ${stringify(err)}`)
      })
    })
  }

  /**
   * 发一条带内联键盘的 markdown（审批卡片用）。
   * 走主动发送，不依赖 msg_id —— 审批可能落在被动回复窗口之外。
   */
  async sendCard(
    scope: 'group' | 'c2c',
    targetId: string,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    await this.bot.sendMarkdown({ scope, targetId }, text, keyboard === undefined ? undefined : { keyboard })
  }

  /**
   * 启动连接。`bot.start()` 会一直阻塞到 stop()，所以这里不 await ——
   * 连接在后台建立，失败会走 onError。
   */
  start(): void {
    if (this.started) return
    this.started = true
    void this.bot.start().catch((err: unknown) => {
      this.log(`[dsh-yashiro] 网关退出: ${stringify(err)}`)
    })
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    try {
      this.bot.stop()
    } catch {
      /* 已经断开 */
    }
  }

  /** 往一个群/用户主动发送消息（不依赖 msg_id）。超长自动切分。 */
  async send(scope: 'group' | 'c2c', targetId: string, text: string): Promise<number> {
    const chunks = chunkText(text, this.config.sendChunkLimit)
    let sent = 0
    for (const chunk of chunks) {
      if (chunk.trim().length === 0) continue
      await this.bot.sendText({ scope, targetId }, chunk)
      sent += 1
    }
    return sent
  }
}

/** 按长度切分文本，尽量在换行处断开 */
export function chunkText(text: string, limit: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= limit) return [normalized]

  const chunks: string[] = []
  let rest = normalized
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf(' '))
    const at = cut > limit * 0.5 ? cut + 1 : limit
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
