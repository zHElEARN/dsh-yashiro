/**
 * QQ 平台网关：连接、事件归一化、发送。
 *
 * 三个平台侧的坑：全量模式下 @ 消息也叫 `GROUP_MESSAGE_CREATE`（判断靠 `mentions[].is_you`，
 * 不能看事件名）；`content` 里的 `<@OPENID>` 标记平台不会剥；`msg_elements[0]` 才是被引用
 * 那条消息。没开全量模式的群只会推 `GROUP_AT_MESSAGE_CREATE`，两种事件名都要认。
 */
import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import type {
  InboundMessage,
  InlineKeyboard,
  InteractionEvent,
} from "@tencent-connect/qqbot-nodejs";
import {
  getMaxUploadSize,
  MediaFileType,
  QQBot,
} from "@tencent-connect/qqbot-nodejs";
import { FULL_INTENTS } from "@tencent-connect/qqbot-nodejs/protocol";

import type { Config } from "../core/config.js";
import { describeError } from "../core/errors.js";
import { formatSize } from "../core/format.js";
import type { Logger } from "../core/logger.js";
import type { MentionInfo, PeerRef, Scope } from "../core/types.js";
import type { AttachmentInfo, StoredMessage } from "../store.js";

/** 官方文档说 GROUP_MESSAGE (1<<25) 就够，但收非 @ 消息必须额外带上这一位 */
const GROUP_MESSAGE_INTENT = 1 << 24;

const SANDBOX_BASE_URL = "https://sandbox.api.sgroup.qq.com";

/** 单条消息最大字符数，超出自动切分 */
const SEND_CHUNK_LIMIT = 4500;

/** 发送文件时按扩展名选的富媒体类型 */
export type MediaKind = "image" | "video" | "voice" | "file";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const VOICE_EXTS = new Set([".mp3", ".wav", ".ogg", ".aac", ".silk", ".amr"]);

/** 发送文件时对外报的类型名，用于错误文案 */
const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  image: "图片",
  video: "视频",
  voice: "语音",
  file: "文件",
};

const MEDIA_FILE_TYPE: Record<MediaKind, MediaFileType> = {
  image: MediaFileType.IMAGE,
  video: MediaFileType.VIDEO,
  voice: MediaFileType.VOICE,
  file: MediaFileType.FILE,
};

/** 按扩展名决定发成图片/视频/语音还是普通文件；认不出的一律当普通文件 */
export function classifyMedia(filePath: string): MediaKind {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (VOICE_EXTS.has(ext)) return "voice";
  return "file";
}

/** 发送一个文件后回报给调用方的东西 */
export interface SentFile {
  kind: MediaKind;
  fileName: string;
  fileSize: number;
}

/**
 * 校验待发送的文件并定出类型：存在、是普通文件、不超平台对该类型的上限。
 *
 * 和真正发送拆开是为了可测 —— 构造 YashiroGateway 需要真的连 QQ。
 */
export function inspectFileForSend(localPath: string): SentFile {
  const fileName = basename(localPath);
  let fileSize: number;
  try {
    const info = statSync(localPath);
    if (!info.isFile()) throw new Error("不是一个普通文件");
    fileSize = info.size;
  } catch (err) {
    throw new Error(
      `读不到文件 ${localPath}：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const kind = classifyMedia(localPath);
  const maxSize = getMaxUploadSize(MEDIA_FILE_TYPE[kind]);
  if (fileSize > maxSize) {
    throw new Error(
      `${fileName} 有 ${formatSize(fileSize)}，超过 QQ 对${MEDIA_KIND_LABEL[kind]}的 ${formatSize(maxSize)} 上限`,
    );
  }

  return { kind, fileName, fileSize };
}

/** 平台 `mentions[]` 的形状，字段名是下划线风格 */
interface MentionLike {
  scope?: "all" | "single";
  is_you?: boolean;
  id?: string;
  user_openid?: string;
  member_openid?: string;
  nickname?: string;
  username?: string;
}

/** 平台给的原始结构，字段名是下划线风格；只声明我们用得到的 */
interface RawAttachmentLike {
  content_type?: string;
  url?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  asr_refer_text?: string;
  voice_wav_url?: string;
}

interface MsgElementLike {
  content?: string;
  message_type?: number;
  attachments?: RawAttachmentLike[];
}

/**
 * 正文清洗：`<@OPENID>` 换成 `@昵称`，表情标记收敛成 `[表情]`。
 *
 * @ 一律保留（@机器人 和 @别人 都在），因为「@ 了谁」是对话信息的一部分；
 * 名字取自 mentions，取不到就保留原始标记 —— 宁可不统一也不丢信息。
 */
export function formatContent(
  content: string,
  mentions?: MentionLike[],
): string {
  const names = new Map<string, string>();
  for (const mention of mentions ?? []) {
    const name = mention.nickname ?? mention.username;
    if (name === undefined) continue;
    for (const id of [mention.id, mention.member_openid, mention.user_openid]) {
      if (id) names.set(id, name);
    }
  }

  return (
    content
      // 补一个空格：@ 标记和后面的字可能贴在一起（`<@BOT>/id`），分开才认得出指令
      .replace(/<@!?([0-9A-Za-z_-]+)>/g, (whole, id: string) => {
        const name = names.get(id);
        return name === undefined ? `${whole} ` : `@${name} `;
      })
      // 表情标记：新旧两种格式，和腾讯自己的 contentSanitizer 认的一致
      .replace(/\[<face,id=\d+\/?>]/g, "[表情]")
      .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/g, "[表情]")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

/** 把平台的 `mentions[]` 收成我们能存的形状 */
function toMentionInfo(mentions?: MentionLike[]): MentionInfo[] | undefined {
  if (mentions === undefined || mentions.length === 0) return undefined;
  return mentions.map((mention) => {
    const id = mention.id ?? mention.member_openid ?? mention.user_openid;
    const name = mention.nickname ?? mention.username;
    return {
      ...(id ? { id: String(id) } : {}),
      ...(name ? { name: String(name) } : {}),
      ...(mention.is_you ? { isYou: true } : {}),
      ...(mention.scope === "all" ? { isAll: true } : {}),
    };
  });
}

function isBotMentioned(msg: InboundMessage): boolean {
  // 老形态：平台直接推的 @ 事件，必然 @ 了机器人
  if (
    msg.rawEventType === "GROUP_AT_MESSAGE_CREATE" ||
    msg.rawEventType === "AT_MESSAGE_CREATE"
  ) {
    return true;
  }
  if (Array.isArray(msg.mentions)) {
    return msg.mentions.some((m) => m?.is_you === true);
  }
  return false;
}

/** 平台附件 → 只搬元信息，不下载文件本体 */
function toAttachmentInfo(
  raw: RawAttachmentLike,
  from: "current" | "quoted",
): AttachmentInfo {
  // 语音只留平台转码后的 WAV：ffmpeg 之类的工具能直接吃，原始 SILK/AMR 不行
  const url =
    raw.content_type === "voice" ? (raw.voice_wav_url ?? raw.url) : raw.url;
  return {
    contentType: raw.content_type ? String(raw.content_type) : "unknown",
    from,
    ...(url ? { url: String(url) } : {}),
    ...(raw.filename ? { filename: String(raw.filename) } : {}),
    ...(typeof raw.size === "number" ? { size: raw.size } : {}),
    ...(typeof raw.width === "number" ? { width: raw.width } : {}),
    ...(typeof raw.height === "number" ? { height: raw.height } : {}),
    ...(raw.asr_refer_text ? { asrText: String(raw.asr_refer_text) } : {}),
  };
}

export function normalizeInbound(
  appId: string,
  msg: InboundMessage,
): StoredMessage | null {
  const scope: Scope = msg.kind === "c2c" ? "c2c" : "group";
  if (msg.kind !== "group" && msg.kind !== "c2c") return null;

  const peerId = scope === "group" ? (msg.groupOpenid ?? "") : msg.senderId;
  if (!peerId) return null;

  const elements = (msg as unknown as { msgElements?: MsgElementLike[] })
    .msgElements;
  const quotedElement = elements?.[0];
  const quoted = quotedElement?.content;

  // 附件有两个来源，都必须带上：当前消息的 msg.attachments、被引用消息的
  // elements[0].attachments（引用一张纯图片时，附件全在后者，正文是空的）
  const ownAttachments = (msg.attachments ??
    []) as unknown as RawAttachmentLike[];
  const quotedAttachments = quotedElement?.attachments ?? [];
  const attachments: AttachmentInfo[] = [
    ...ownAttachments.map((a) => toAttachmentInfo(a, "current")),
    ...quotedAttachments.map((a) => toAttachmentInfo(a, "quoted")),
  ];
  const mentions = toMentionInfo(msg.mentions);

  return {
    appId,
    scope,
    peerId,
    messageId: msg.messageId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    content: formatContent(msg.content ?? "", msg.mentions),
    mentionsBot: isBotMentioned(msg),
    ...(mentions ? { mentions } : {}),
    quotedContent: quoted ? formatContent(quoted, msg.mentions) : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    rawEventType: msg.rawEventType,
    timestamp: msg.timestamp,
  };
}

export interface GatewayHandlers {
  /** 回调时消息还没入库，落库由 handler 自己负责 */
  onMessage(msg: StoredMessage): void;
  /** 连接就绪 / 连接出错，插件不关心时可以不给 */
  onReady?(): void;
  onError?(err: unknown): void;
  /** 审批按钮被点击。返回 ack code（0 成功 / 4 没权限）；undefined = 不是本插件的按钮 */
  onInteraction?(event: InteractionEvent): number | undefined;
}

export class YashiroGateway {
  private readonly bot: QQBot;
  private started = false;

  constructor(
    config: Config,
    handlers: GatewayHandlers,
    private readonly logger: Logger,
  ) {
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: config.sandbox ? SANDBOX_BASE_URL : undefined,
      intents: FULL_INTENTS | GROUP_MESSAGE_INTENT,
      markdownSupport: true,
      // QQ SDK 很吵，debug 与 info 都压到 debug 档，只有 warn / error 直达
      logger: {
        debug: (m?: unknown) => logger.debug(`[qqbot] ${describeError(m)}`),
        info: (m?: unknown) => logger.debug(`[qqbot] ${describeError(m)}`),
        warn: (m?: unknown) => logger.warn(`[qqbot] ${describeError(m)}`),
        error: (m?: unknown) => logger.error(`[qqbot] ${describeError(m)}`),
      },
    });

    this.bot.on("ready", () => {
      logger.info("QQ WebSocket 已连接（READY）");
      handlers.onReady?.();
    });

    this.bot.on("resumed", () =>
      logger.debug("QQ WebSocket 会话已恢复（RESUMED）"),
    );

    this.bot.on("error", (err: unknown) => {
      logger.error(`QQ 连接错误: ${describeError(err)}`);
      handlers.onError?.(err);
    });

    this.bot.on("message", (_ctx: unknown, msg: InboundMessage) => {
      try {
        // 平台原始事件只在 debug 下落盘。msg_elements 的语义（图文混排的顺序、
        // 引用结构）官方文档没写清楚，排这类坑时只能靠真机 payload。
        logger.debug(`原始事件: ${JSON.stringify(msg.raw)}`);
        const normalized = normalizeInbound(config.appId, msg);
        if (!normalized) return;
        logger.debug(
          `收到消息 type=${normalized.rawEventType} peer=${normalized.peerId} ` +
            `from=${normalized.senderName ?? normalized.senderId} mention=${normalized.mentionsBot} ` +
            `content=${JSON.stringify(normalized.content.slice(0, 80))}`,
        );
        handlers.onMessage(normalized);
      } catch (err) {
        logger.error(`处理入站消息失败: ${describeError(err)}`);
      }
    });

    // 审批按钮点击：INTERACTION_CREATE 经 WebSocket 推过来，不需要回调服务器。
    // 必须回执，否则客户端按钮一直转圈；不是本插件的按钮回 3（重复操作）。
    this.bot.on("interaction", (_ctx: unknown, event: InteractionEvent) => {
      let code = 3;
      try {
        code = handlers.onInteraction?.(event) ?? 3;
      } catch (err) {
        logger.error(`处理按钮点击失败: ${describeError(err)}`);
      }
      void this.bot
        .acknowledgeInteraction(event.id, code)
        .catch((err: unknown) => {
          logger.error(`按钮点击回执失败: ${describeError(err)}`);
        });
    });
  }

  /** 发带内联键盘的 markdown（审批卡片）。主动发送，不依赖 msg_id */
  async sendCard(
    peer: PeerRef,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    await this.bot.sendMarkdown(
      qqTarget(peer),
      text,
      keyboard === undefined ? undefined : { keyboard },
    );
  }

  /** `bot.start()` 会一直阻塞到 stop()，所以这里不能 await，连接在后台建立 */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.bot.start().catch((err: unknown) => {
      this.logger.debug(`网关退出: ${describeError(err)}`);
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.bot.stop();
    } catch {
      /* 已经断开 */
    }
  }

  /** 主动发送（不依赖 msg_id），超长自动切分 */
  async send(peer: PeerRef, text: string): Promise<number> {
    const target = qqTarget(peer);
    let sent = 0;
    for (const chunk of chunkText(text, SEND_CHUNK_LIMIT)) {
      if (chunk.trim().length === 0) continue;
      await this.bot.sendText(target, chunk);
      sent += 1;
    }
    return sent;
  }

  /**
   * 发送本地文件，按扩展名分发到图片/视频/语音/普通文件。和 send() 一样不绑 msg_id
   * （主动推送），所以不受被动回复时效约束。
   *
   * 路径不做白名单限制 —— agent 本来就跑在宿主的文件沙箱里，这里不再叠一层；代价是
   * 这个工具能读到什么就能发出去什么（见 README「设计取舍」）。
   *
   * 通用文件消息需要机器人有「文件消息」权限，没有的话平台会拒绝，错误原样上抛给 agent。
   */
  async sendFile(peer: PeerRef, localPath: string): Promise<SentFile> {
    const inspected = inspectFileForSend(localPath);
    const { kind, fileName } = inspected;

    const target = qqTarget(peer);
    const source = { localPath };
    if (kind === "image") await this.bot.sendImage(target, source);
    else if (kind === "video") await this.bot.sendVideo(target, source);
    else if (kind === "voice") await this.bot.sendVoice(target, source);
    else await this.bot.sendFile(target, source, { fileName });

    return inspected;
  }
}

/** QQ SDK 的入参叫 targetId，插件内部一律叫 peerId */
function qqTarget(peer: PeerRef): { scope: Scope; targetId: string } {
  return { scope: peer.scope, targetId: peer.peerId };
}

/** 优先在换行 / 句号 / 空格处断开，切点太靠前就硬切 */
export function chunkText(text: string, limit: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf("。"),
      window.lastIndexOf(" "),
    );
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
