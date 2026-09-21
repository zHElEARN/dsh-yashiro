/**
 * 挂给每个 agent 的三个工具。
 *
 * 它们通过闭包绑定到这个 agent 所属的群/单聊，agent 不能指定目标 —— 免得它发错群。
 */
import { resolve } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

import type { Config } from "../core/config.js";
import { formatSize, truncate, whereLabel } from "../core/format.js";
import { formatTime } from "../core/time.js";
import { chatKey, type PeerRef } from "../core/types.js";
import type { YashiroGateway } from "../qq/gateway.js";
import { describeAttachment } from "../qq/message-text.js";
import type { AttachmentInfo, HistoryStore } from "../store.js";

export interface ToolDeps {
  store: HistoryStore;
  gateway: YashiroGateway;
  config: Config;
  peer: PeerRef;
}

/** 单条消息在工具结果里的最大字符数，避免一次查询把上下文撑爆 */
const PER_MESSAGE_CHARS = 400;

/** qqbot_history 不传 limit 时的默认条数 */
export const HISTORY_DEFAULT_LIMIT = 30;

/** qqbot_history 单次查询允许返回的最大条数 */
export const HISTORY_MAX_LIMIT = 200;

/**
 * 历史里一条附件的呈现：类型/文件名/尺寸一行说清，后面跟 URL 与语音转写。
 *
 * 刻意不截断 —— URL 截一半就废了。条数天然很少（平台一条消息带不了几个附件）。
 */
function describeAttachmentForHistory(attachment: AttachmentInfo): string {
  const parts = [describeAttachment(attachment)];
  if (attachment.url) parts.push(attachment.url);
  if (attachment.asrText) parts.push(`转写：${attachment.asrText}`);
  return parts.join("  ");
}

export function createHistoryTool(deps: ToolDeps) {
  const { store, config, peer } = deps;
  const key = chatKey(config.appId, peer);
  return defineTool({
    name: "qqbot_history",
    description:
      "查询当前 QQ 群或单聊的历史消息记录。不传参数则返回最近若干条。",
    parameters: {
      query: {
        type: "string",
        description:
          "关键词，匹配消息正文与被引用内容（子串匹配，对中文友好）。留空表示不限。",
      },
      sender: {
        type: "string",
        description: "按发送者昵称过滤（模糊匹配）。留空表示不限。",
      },
      since_minutes: {
        type: "number",
        description: "只看最近多少分钟内的消息。留空表示不限。",
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
          count: {
            type: "integer",
            required: true,
            description: "实际返回的条数",
          },
          messages: {
            type: "array",
            required: true,
            description: "按时间正序排列的消息",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                time: { type: "string", required: true },
                sender: { type: "string", required: true },
                content: { type: "string", required: true },
                quoted: { type: "string" },
                attachments: {
                  type: "array",
                  description:
                    "这条消息带的附件。只有元信息，插件不下载文件本体",
                  items: { type: "string" },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const listed = value.messages
          .map((m) => {
            const quoted = m.quoted ? `\n  ↳ 引用了：${m.quoted}` : "";
            const files = (m.attachments ?? [])
              .map((a) => `\n  ↳ 附件：${a}`)
              .join("");
            return `[${m.time}] ${m.sender}: ${m.content}${quoted}${files}`;
          })
          .join("\n");
        const body = value.count === 0 ? "没有查到符合条件的消息。" : listed;
        return [{ type: "text", text: `共 ${value.count} 条：\n${body}` }];
      },
    },
    async execute(args) {
      const limit = Math.min(
        Math.max(1, Math.floor(args.limit ?? HISTORY_DEFAULT_LIMIT)),
        HISTORY_MAX_LIMIT,
      );
      const since =
        args.since_minutes !== undefined && Number.isFinite(args.since_minutes)
          ? Date.now() - Math.max(0, args.since_minutes) * 60_000
          : undefined;

      const rows = store.search({
        appId: key.appId,
        scope: key.scope,
        peerId: key.peerId,
        ...(args.query ? { query: args.query } : {}),
        ...(args.sender ? { senderName: args.sender } : {}),
        ...(since !== undefined ? { since } : {}),
        limit,
        order: "desc",
      });
      // search 是"由近及远"，返回给模型时按时间正序更好读
      rows.reverse();

      return {
        count: rows.length,
        messages: rows.map((row) => ({
          time: formatTime(row.ts),
          sender: row.senderName ?? row.senderId,
          content: truncate(row.content, PER_MESSAGE_CHARS),
          ...(row.quotedContent
            ? { quoted: truncate(row.quotedContent, PER_MESSAGE_CHARS) }
            : {}),
          ...(row.attachments?.length
            ? { attachments: row.attachments.map(describeAttachmentForHistory) }
            : {}),
        })),
      };
    },
  });
}

export function createSendTool(deps: ToolDeps) {
  const { gateway, store, config, peer } = deps;
  const key = chatKey(config.appId, peer);
  return defineTool({
    name: "qqbot_send",
    description: "把一条消息发送到当前 QQ 群或单聊，内容按 markdown 渲染。",
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
        properties: {
          sent: {
            type: "integer",
            required: true,
            description: "实际发出的消息条数",
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `已发出 ${value.sent} 条消息到${whereLabel(peer.scope)}里。`,
        },
      ],
    },
    async execute(args) {
      const sent = await gateway.send(peer, args.text);
      store.appendOutbound(key, args.text);
      return { sent };
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
      // 和 qqbot_send 一样落库：agent 事后翻历史时才知道自己发过什么
      store.appendOutbound(
        key,
        `[文件] ${sent.fileName}（${formatSize(sent.fileSize)}）`,
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
