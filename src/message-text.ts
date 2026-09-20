/**
 * 把一条入站消息拼成送给 agent 的正文。
 *
 * 抽成独立模块是为了可测 —— 之前这段逻辑内联在 apply() 里，
 * 「引用的图片附件没传下去」这个 bug 就是因为没人覆盖到它。
 *
 * 设计原则：**附件只搬运平台的元信息（URL、类型、尺寸、语音转写），插件不下载、
 * 不持久化**。什么时候下、要不要下，全由 agent 自己决定；QQ 的 URL 带时效，
 * 过期了就算了。
 */
import type { AttachmentInfo, StoredMessage } from './store.js'

const CONTENT_TYPE_LABELS: Array<[RegExp, string]> = [
  [/^image\//, '图片'],
  [/^voice$/, '语音'],
  [/^audio\//, '音频'],
  [/^video\//, '视频'],
  [/^file$/, '文件'],
]

/** 把 MIME 类型翻成人话 */
export function attachmentKindLabel(contentType: string): string {
  for (const [pattern, label] of CONTENT_TYPE_LABELS) {
    if (pattern.test(contentType)) return label
  }
  return '附件'
}

/** 字节数 → 人话 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 一行附件描述，如 `图片 cat.jpg 1206x2622 1.3MB` */
export function describeAttachment(attachment: AttachmentInfo): string {
  const parts = [attachmentKindLabel(attachment.contentType)]
  if (attachment.filename) parts.push(attachment.filename)
  if (typeof attachment.width === 'number' && typeof attachment.height === 'number') {
    parts.push(`${attachment.width}x${attachment.height}`)
  }
  if (typeof attachment.size === 'number') parts.push(formatSize(attachment.size))
  return parts.join(' ')
}

export interface UserTextOptions {
  /** 自上次唤醒以来群里新增的非 @ 消息数 */
  newSinceLastWake?: number
}

/**
 * 组装这条 @ 消息送进 agent 的正文。
 *
 * 附件分两拨给：被引用那条消息带的、以及当前这条消息自带的 ——
 * 「引用一张图再 @ 它」走的是前者，被引用消息没有文字，附件全在那里。
 */
export function buildUserText(msg: StoredMessage, options: UserTextOptions = {}): string {
  const where = msg.scope === 'group' ? '群里' : '单聊里'
  const who = msg.senderName ?? msg.senderId

  const lines = [
    `${who} 在${where} @ 了你：`,
    '',
    msg.content.trim().length > 0 ? msg.content : '（这条消息没有文字内容）',
  ]

  if (msg.quotedContent && msg.quotedContent.trim().length > 0) {
    lines.push('', `（引用了：${msg.quotedContent}）`)
  }

  const attachments = msg.attachments ?? []
  const quotedAttachments = attachments.filter((a) => a.from === 'quoted')
  const ownAttachments = attachments.filter((a) => a.from === 'current')

  if (quotedAttachments.length > 0) {
    lines.push('', '（被引用的那条消息带附件：）')
    for (const attachment of quotedAttachments) appendAttachment(lines, attachment)
  }
  if (ownAttachments.length > 0) {
    lines.push('', '（这条消息带附件：）')
    for (const attachment of ownAttachments) appendAttachment(lines, attachment)
  }

  if (options.newSinceLastWake !== undefined && options.newSinceLastWake > 0) {
    lines.push(
      '',
      `（自你上次开口以来，群里还有 ${options.newSinceLastWake} 条新消息。）`,
    )
  }

  return lines.join('\n')
}

function appendAttachment(lines: string[], attachment: AttachmentInfo): void {
  lines.push(`  - ${describeAttachment(attachment)}`)
  if (attachment.url) lines.push(`    URL: ${attachment.url}`)
  if (attachment.asrText) lines.push(`    平台转写文本: ${attachment.asrText}`)
}
