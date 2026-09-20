/**
 * 把一条入站消息拼成送给 agent 的正文。
 *
 * 附件只搬平台的元信息（URL、类型、尺寸、语音转写），插件不下载也不持久化：
 * 下不下、什么时候下由 agent 自己决定，QQ 的 URL 带时效，过期就算了。
 */
import type { AttachmentInfo, StoredMessage } from '../store.js'

const CONTENT_TYPE_LABELS: Array<[RegExp, string]> = [
  [/^image\//, '图片'],
  [/^voice$/, '语音'],
  [/^audio\//, '音频'],
  [/^video\//, '视频'],
  [/^file$/, '文件'],
]

export function attachmentKindLabel(contentType: string): string {
  for (const [pattern, label] of CONTENT_TYPE_LABELS) {
    if (pattern.test(contentType)) return label
  }
  return '附件'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

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
