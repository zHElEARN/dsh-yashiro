/**
 * 挂给每个 agent 的三个工具。
 *
 * 它们通过闭包绑定到这个 agent 所属的群/单聊，agent 不能指定目标 —— 免得它发错群。
 */
import { resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  getMimeType,
  TEXT_CHUNK_LIMIT,
} from "@tencent-connect/qqbot-nodejs/protocol";

import type { Config } from "../core/config.js";
import { formatSize, whereLabel } from "../core/format.js";
import {
  DISPLAY_UTC_OFFSET,
  formatShortTime,
  formatTime,
  formatWeekday,
} from "../core/time.js";
import { chatKey, type PeerRef } from "../core/types.js";
import type { YashiroGateway } from "../qq/gateway.js";
import { describeAttachment } from "../qq/message-text.js";
import type { AttachmentInfo, HistoryStore, MessageFilter } from "../store.js";

export interface ToolDeps {
  store: HistoryStore;
  gateway: YashiroGateway;
  config: Config;
  peer: PeerRef;
}

/** qqbot_history 不传 limit 时的默认条数 */
export const HISTORY_DEFAULT_LIMIT = 30;

/**
 * qqbot_history 单次查询允许返回的最大条数。
 *
 * 定在 50 是量出来的：不截断时 50 条实测约 42KB，正好卡在 dsh 自己的 spill 上限
 * （50000 字节）之下 —— 再多就会出现"结果被按字节对半砍、模型还得去读溢出文件"。
 */
export const HISTORY_MAX_LIMIT = 50;

/**
 * 历史里一条附件的呈现：类型/文件名/尺寸一行说清，后面跟 URL 与语音转写。
 *
 * 刻意不截断 —— URL 截一半就废了。
 */
function describeAttachmentForHistory(attachment: AttachmentInfo): string {
  const parts = [describeAttachment(attachment)];
  if (attachment.url) parts.push(attachment.url);
  if (attachment.asrText) parts.push(`转写：${attachment.asrText}`);
  return parts.join("  ");
}

function clampLimit(value: number | undefined): number {
  return Math.min(
    Math.max(1, Math.floor(value ?? HISTORY_DEFAULT_LIMIT)),
    HISTORY_MAX_LIMIT,
  );
}

/**
 * `since` / `until` 的取值：数字按 epoch 秒（顺手容忍毫秒），字符串按 ISO 8601。
 *
 * 模型手上没有时钟，所以结果头部一定会告诉它"现在几点"，绝对时间才用得上。
 */
function parseInstant(
  value: number | string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} 不是有效数字`);
    // 1e11 秒是公元 5138 年，所以超过它的一律当毫秒
    return Math.floor(value > 1e11 ? value : value * 1000);
  }
  const text = value.trim();
  if (text.length === 0) return undefined;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${label} 认不出这个时间：${text}。给 ISO 8601（2026-09-21T15:00:00+08:00）或 epoch 秒。`,
    );
  }
  return parsed;
}

function historyToolDescription(scope: PeerRef["scope"]): string {
  const where = whereLabel(scope);
  return [
    `查这个 QQ ${where}的历史消息：这里记着${where}里的全部消息（含没 @ 你的）和你自己发过的每一句，按时间正序返回。`,
    `不传参数就返回最近 ${HISTORY_DEFAULT_LIMIT} 条。每条消息前面有 #编号，把它交给 before_seq 可以继续往前翻，交给 after_seq 可以往后翻。`,
    "结果开头两行给出：现在时间、这个会话一共有多少条消息、本次取到多少条、以及两个方向继续取要用的游标（取全了就没有游标）。",
    "sender 按昵称或 openid 匹配；query 匹配正文、被引用内容和附件；mentions_me: false 可以只看没 @ 你的消息。",
  ].join("\n");
}

export function createHistoryTool(deps: ToolDeps) {
  const { store, config, peer } = deps;
  const key = chatKey(config.appId, peer);
  const where = whereLabel(peer.scope);
  // 单聊里每条都是冲着 agent 说的，再标「@你」等于给每条都盖个没用的章
  const isGroup = peer.scope === "group";

  return defineTool({
    name: "qqbot_history",
    description: historyToolDescription(peer.scope),
    parameters: {
      query: {
        type: "string",
        description:
          "关键词（子串匹配）：正文、被引用的内容、附件文件名与 URL。留空表示不限。",
      },
      sender: {
        type: "string",
        description: "按发送者过滤（子串匹配昵称或 openid）。留空表示不限。",
      },
      since: {
        oneOf: [{ type: "number" }, { type: "string" }],
        description:
          "只看这个时刻之后的（含）。数字按 epoch 秒，字符串按 ISO 8601（2026-09-21T15:00:00+08:00）。",
      },
      until: {
        oneOf: [{ type: "number" }, { type: "string" }],
        description: "只看这个时刻之前的（含），格式同 since。",
      },
      since_minutes: {
        type: "number",
        description: `只看最近多少分钟内的消息。与 since 只能给一个。`,
      },
      before_seq: {
        type: "number",
        description: "要 #编号小于它的消息，也就是从某条往前翻更早的。",
      },
      after_seq: {
        type: "number",
        description: "要 #编号大于它的消息，也就是从某条往后取更新的。",
      },
      mentions_me: {
        type: "boolean",
        description:
          "true 只看 @ 过你的消息，false 只看没 @ 你的（你自己错过的那些）。留空表示不限。",
      },
      limit: {
        type: "number",
        description: `返回条数，默认 ${HISTORY_DEFAULT_LIMIT}，上限 ${HISTORY_MAX_LIMIT}。`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          now: {
            type: "string",
            required: true,
            description: "当前时间（含时区与星期）",
          },
          where: { type: "string", required: true, description: "群 或 单聊" },
          total: {
            type: "integer",
            required: true,
            description: "这个会话一共存了多少条",
          },
          firstTime: { type: "string", description: "会话里最早一条的时间" },
          lastTime: { type: "string", description: "会话里最新一条的时间" },
          returned: {
            type: "integer",
            required: true,
            description: "本次返回条数",
          },
          older: {
            type: "integer",
            required: true,
            description: "同条件下还有多少条更早的",
          },
          newer: {
            type: "integer",
            required: true,
            description: "同条件下还有多少条更新的",
          },
          olderCursor: {
            type: "integer",
            description: "取更早那批时传给 before_seq 的值",
          },
          newerCursor: {
            type: "integer",
            description: "取更新那批时传给 after_seq 的值",
          },
          limitAsked: {
            type: "integer",
            description: "模型要的条数超过上限时，这里原样带回它要的值",
          },
          messages: {
            type: "array",
            required: true,
            description: "按时间正序排列的消息",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "integer",
                  required: true,
                  description: "消息编号",
                },
                time: { type: "string", required: true },
                sender: { type: "string", required: true },
                mentionsMe: {
                  type: "boolean",
                  required: true,
                  description: "这条 @ 了机器人",
                },
                content: {
                  type: "string",
                  required: true,
                  description: "原样正文",
                },
                quotedFrom: {
                  type: "string",
                  description: "被引用那条的说话人（查不到就不给）",
                },
                quotedText: { type: "string", description: "被引用的原文" },
                attachments: {
                  type: "array",
                  description: "附件元信息，插件不下载文件本体",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      from: {
                        type: "string",
                        required: true,
                        description:
                          "current = 本条消息的，quoted = 被引用那条的",
                      },
                      text: { type: "string", required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const span =
          value.firstTime !== undefined && value.lastTime !== undefined
            ? `（${value.firstTime} → ${value.lastTime}）`
            : "";

        const summary = [`本次 ${value.returned} 条`];
        if (value.limitAsked !== undefined) {
          summary.push(
            `你要了 ${value.limitAsked} 条，上限 ${HISTORY_MAX_LIMIT}`,
          );
        }
        if (value.older > 0 && value.olderCursor !== undefined) {
          summary.push(
            `同条件下更早还有 ${value.older} 条：before_seq=${value.olderCursor}`,
          );
        }
        if (value.newer > 0 && value.newerCursor !== undefined) {
          summary.push(
            `更新还有 ${value.newer} 条：after_seq=${value.newerCursor}`,
          );
        }
        if (value.older === 0 && value.newer === 0) summary.push("已取全");

        const head = `现在 ${value.now}｜本${value.where}共 ${value.total} 条${span}`;
        if (value.messages.length === 0) {
          return [
            {
              type: "text",
              text: `${head}\n${summary.join("｜")}\n（没有符合条件的消息）`,
            },
          ];
        }

        const blocks = value.messages.map((message) => {
          const lines = [
            `[#${message.id}] ${message.time} ${message.sender}${
              message.mentionsMe && isGroup ? "〔@你〕" : ""
            }：`,
            message.content.length > 0 ? message.content : "（没有文字内容）",
          ];
          if (message.quotedText !== undefined) {
            const from =
              message.quotedFrom !== undefined ? ` ${message.quotedFrom}` : "";
            lines.push(`  ↳ 引用${from}：${message.quotedText}`);
          }
          for (const attachment of message.attachments ?? []) {
            const label =
              attachment.from === "quoted" ? "引用附件" : "本条附件";
            lines.push(`  ↳ ${label}：${attachment.text}`);
          }
          return lines.join("\n");
        });

        return [
          {
            type: "text",
            text: `${head}\n${summary.join("｜")}\n\n${blocks.join("\n\n")}`,
          },
        ];
      },
    },
    async execute(args) {
      if (args.before_seq !== undefined && args.after_seq !== undefined) {
        throw new Error(
          "before_seq 与 after_seq 只能给一个：前者往前翻，后者往后取。",
        );
      }
      if (args.since !== undefined && args.since_minutes !== undefined) {
        throw new Error(
          "since 与 since_minutes 只能给一个，它们说的是同一件事。",
        );
      }

      const limit = clampLimit(args.limit);
      const now = Date.now();
      const since =
        args.since_minutes !== undefined
          ? now - Math.max(0, args.since_minutes) * 60_000
          : parseInstant(args.since, "since");
      const until = parseInstant(args.until, "until");
      if (since !== undefined && until !== undefined && since > until) {
        throw new Error("since 比 until 还晚，这个区间里不可能有消息。");
      }

      const filter: MessageFilter = {
        appId: key.appId,
        scope: key.scope,
        peerId: key.peerId,
        ...(args.query ? { query: args.query } : {}),
        ...(args.sender ? { sender: args.sender } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(args.mentions_me !== undefined
          ? { mentionsMe: args.mentions_me }
          : {}),
      };

      // after_seq 是"往后取"，要锚点之后最早的那批；其余都是"取最近的"
      const forward = args.after_seq !== undefined;
      const rows = store.search({
        ...filter,
        ...(args.before_seq !== undefined
          ? { beforeSeq: args.before_seq }
          : {}),
        ...(forward ? { afterSeq: args.after_seq } : {}),
        limit,
        order: forward ? "asc" : "desc",
      });
      // search 是"由近及远"，返回给模型时按时间正序更好读
      if (!forward) rows.reverse();

      const stats = store.stats(key);
      const newest = rows[rows.length - 1];
      const oldest = rows[0];
      const older = oldest
        ? store.count({ ...filter, beforeSeq: oldest.seq })
        : 0;
      const newer = newest
        ? store.count({ ...filter, afterSeq: newest.seq })
        : 0;

      return {
        now: `${formatTime(now)} ${DISPLAY_UTC_OFFSET}（${formatWeekday(now)}）`,
        where,
        total: stats.total,
        ...(stats.firstTs !== undefined
          ? { firstTime: formatShortTime(stats.firstTs) }
          : {}),
        ...(stats.lastTs !== undefined
          ? { lastTime: formatShortTime(stats.lastTs) }
          : {}),
        returned: rows.length,
        older,
        newer,
        ...(older > 0 && oldest ? { olderCursor: oldest.seq } : {}),
        ...(newer > 0 && newest ? { newerCursor: newest.seq } : {}),
        ...(args.limit !== undefined && args.limit > HISTORY_MAX_LIMIT
          ? { limitAsked: Math.floor(args.limit) }
          : {}),
        messages: rows.map((row) => ({
          id: row.seq,
          time: formatTime(row.ts),
          sender: senderLabel(row.senderName, row.senderId, row.scope),
          mentionsMe: row.mentionsBot,
          content: row.content,
          ...(row.quotedContent !== undefined
            ? {
                quotedText: row.quotedContent,
                ...(row.quotedSenderName !== undefined ||
                row.quotedSenderId !== undefined
                  ? {
                      quotedFrom: senderLabel(
                        row.quotedSenderName,
                        row.quotedSenderId ?? "",
                        row.scope,
                      ),
                    }
                  : {}),
              }
            : {}),
          ...(row.attachments?.length
            ? {
                attachments: row.attachments.map((attachment) => ({
                  from: attachment.from,
                  text: describeAttachmentForHistory(attachment),
                })),
              }
            : {}),
        })),
      };
    },
  });
}

/**
 * 历史里怎么称呼说话人：昵称优先；单聊拿不到昵称时写「对方」（和唤醒消息一致，
 * 不要把一长串 openid 当人名读），群里则退回 openid —— 至少还算个稳定标识。
 */
function senderLabel(
  name: string | undefined,
  id: string,
  scope: PeerRef["scope"],
): string {
  if (name !== undefined && name.length > 0) return name;
  if (scope === "c2c") return "对方";
  return id;
}

export function createSendTool(deps: ToolDeps) {
  const { gateway, store, config, peer } = deps;
  const key = chatKey(config.appId, peer);
  return defineTool({
    name: "qqbot_send",
    description:
      "把一条消息发送到当前 QQ 群或单聊，内容按 markdown 渲染。" +
      `单条上限约 ${TEXT_CHUNK_LIMIT} 字符，更长的内容拆成多次调用分别发送。`,
    parameters: {
      text: {
        type: "string",
        required: true,
        description: "要发送的内容。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      render: () => [
        { type: "text", text: `已发送到${whereLabel(peer.scope)}里。` },
      ],
    },
    async execute(args) {
      await gateway.send(peer, args.text);
      store.appendOutbound(key, args.text);
      return {};
    },
  });
}

export function createSendFileTool(deps: ToolDeps) {
  const { gateway, store, config, peer } = deps;
  const key = chatKey(config.appId, peer);
  return defineTool({
    name: "qqbot_send_file",
    description:
      "把一个本地文件发送到当前 QQ 群或单聊。图片/视频/语音按扩展名自动识别，认不出的当普通文件发。",
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "要发送的文件的路径。文件必须已经存在于磁盘上。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          fileName: { type: "string", required: true, description: "文件名" },
          fileSize: { type: "integer", required: true, description: "字节数" },
          kind: {
            type: "string",
            required: true,
            description: "实际用的发送类型：image / video / voice / file",
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `已发送 ${value.fileName}（${formatSize(value.fileSize)}）到${whereLabel(peer.scope)}里。`,
        },
      ],
    },
    async execute(args) {
      const raw = args.file_path.trim();
      if (raw.length === 0) throw new Error("file_path 不能为空");
      // 相对路径按 agent 的工作目录解析，与 SessionManager 给 agent 的 cwd 一致
      const abs = resolve(config.cwd?.trim() || process.cwd(), raw);

      const sent = await gateway.sendFile(peer, abs);
      // 和 qqbot_send 一样落库：agent 事后翻历史时才知道自己发过什么。
      // 附件也结构化记一笔，和入站消息的历史呈现对齐。
      store.appendOutbound(
        key,
        `[文件] ${sent.fileName}（${formatSize(sent.fileSize)}）`,
        [
          {
            contentType: getMimeType(abs),
            from: "current",
            filename: sent.fileName,
            size: sent.fileSize,
          },
        ],
      );
      return sent;
    },
  });
}

export function createAgentTools(deps: ToolDeps) {
  return [
    createHistoryTool(deps),
    createSendTool(deps),
    createSendFileTool(deps),
  ];
}
