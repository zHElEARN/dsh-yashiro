/**
 * 把一条入站消息拼成送给 agent 的正文。
 *
 * 附件只搬平台的元信息（URL、类型、尺寸、语音转写），插件不下载也不持久化：
 * 下不下、什么时候下由 agent 自己决定，QQ 的 URL 带时效，过期就算了。
 */
import { formatSize, whereLabel } from "../core/format.js";
import type { AttachmentInfo, StoredMessage } from "../store.js";

const CONTENT_TYPE_LABELS: Array<[RegExp, string]> = [
  [/^image\//, "图片"],
  [/^voice$/, "语音"],
  [/^audio\//, "音频"],
  [/^video\//, "视频"],
  [/^file$/, "文件"],
];

function attachmentKindLabel(contentType: string): string {
  for (const [pattern, label] of CONTENT_TYPE_LABELS) {
    if (pattern.test(contentType)) return label;
  }
  return "附件";
}

export function describeAttachment(attachment: AttachmentInfo): string {
  const parts = [attachmentKindLabel(attachment.contentType)];
  if (attachment.filename) parts.push(attachment.filename);
  if (
    typeof attachment.width === "number" &&
    typeof attachment.height === "number"
  ) {
    parts.push(`${attachment.width}x${attachment.height}`);
  }
  if (typeof attachment.size === "number")
    parts.push(formatSize(attachment.size));
  return parts.join(" ");
}

export interface UserTextOptions {
  /** 自上次唤醒以来群里新增的非 @ 消息数 */
  newSinceLastWake?: number;
  /**
   * 上次投递给 agent 的那条消息的 seq。
   *
   * 它是 agent 在时间线上的锚点：唤醒消息里说「投递到 #124」，agent 就能用
   * `qqbot_history(after_seq=124)` 精确取到此后新增的消息，而不是靠猜时间窗。
   * 首次唤醒、以及插件重启后的第一次唤醒都没有这个值。
   */
  lastDeliveredSeq?: number;
}

/**
 * 「你不在的时候群里发生了什么」那一句。
 *
 * 有锚点就一定说出来（哪怕这期间没人说话）—— 锚点是 agent 的时间线位置，不该依赖
 * "恰好有人说话"才出现。
 */
function describeSinceLastWake(options: UserTextOptions): string | undefined {
  const { lastDeliveredSeq, newSinceLastWake } = options;

  if (lastDeliveredSeq === undefined) {
    return newSinceLastWake !== undefined && newSinceLastWake > 0
      ? `自你上次被唤醒以来，群里还有 ${newSinceLastWake} 条没 @ 你的消息。`
      : undefined;
  }

  const tail =
    newSinceLastWake === undefined
      ? ""
      : newSinceLastWake > 0
        ? `；此后群里新增 ${newSinceLastWake} 条没 @ 你的消息`
        : "；此后群里没有新消息";
  return `你上次被唤醒时投递到 #${lastDeliveredSeq}${tail}。`;
}

export function buildUserText(
  msg: StoredMessage,
  options: UserTextOptions = {},
): string {
  // 单聊的 payload 没有昵称、只有一长串 openid，当人名读不通，用「对方」代替
  const who = msg.senderName ?? (msg.scope === "c2c" ? "对方" : msg.senderId);

  const lines = [
    `${who} 在${whereLabel(msg.scope)}里 @ 了你：`,
    "",
    msg.content.trim().length > 0 ? msg.content : "（这条消息没有文字内容）",
  ];

  if (msg.quotedContent && msg.quotedContent.trim().length > 0) {
    lines.push("", `（引用了：${msg.quotedContent}）`);
  }

  const attachments = msg.attachments ?? [];
  const quotedAttachments = attachments.filter((a) => a.from === "quoted");
  const ownAttachments = attachments.filter((a) => a.from === "current");

  if (quotedAttachments.length > 0) {
    lines.push("", "（被引用的那条消息带附件：）");
    for (const attachment of quotedAttachments)
      appendAttachment(lines, attachment);
  }
  if (ownAttachments.length > 0) {
    lines.push("", "（这条消息带附件：）");
    for (const attachment of ownAttachments)
      appendAttachment(lines, attachment);
  }

  const since = describeSinceLastWake(options);
  if (since !== undefined) lines.push("", `（${since}）`);

  return lines.join("\n");
}

function appendAttachment(lines: string[], attachment: AttachmentInfo): void {
  lines.push(`  - ${describeAttachment(attachment)}`);
  if (attachment.url) lines.push(`    URL: ${attachment.url}`);
  if (attachment.asrText) lines.push(`    平台转写文本: ${attachment.asrText}`);
}
