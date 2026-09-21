/**
 * 挂给每个 agent 的两个工具。
 *
 * 它们通过闭包绑定到这个 agent 所属的群/单聊，agent 不能指定目标 —— 免得它发错群。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config } from '../core/config.js'
import { formatTime } from '../core/time.js'
import type { YashiroGateway } from '../qq/gateway.js'
import { describeAttachment } from '../qq/message-text.js'
import type { HistoryStore } from '../store.js'

export interface ToolDeps {
  store: HistoryStore
  gateway: YashiroGateway
  config: Config
  scope: 'group' | 'c2c'
  peerId: string
}

/** 单条消息在工具结果里的最大字符数，避免一次查询把上下文撑爆 */
const PER_MESSAGE_CHARS = 400

/** qqbot_history 不传 limit 时的默认条数 */
export const HISTORY_DEFAULT_LIMIT = 30

/** qqbot_history 单次查询允许返回的最大条数 */
export const HISTORY_MAX_LIMIT = 200

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…（已截断）`
}

export function createHistoryTool(deps: ToolDeps) {
  const { store, config, scope, peerId } = deps
  return defineTool({
    name: 'qqbot_history',
    description: '查询当前 QQ 群或单聊的历史消息记录。不传参数则返回最近若干条。',
    parameters: {
      query: {
        type: 'string',
        description: '关键词，匹配消息正文与被引用内容（子串匹配，对中文友好）。留空表示不限。',
      },
      sender: {
        type: 'string',
        description: '按发送者昵称过滤（模糊匹配）。留空表示不限。',
      },
      since_minutes: {
        type: 'number',
        description: '只看最近多少分钟内的消息。留空表示不限。',
      },
      limit: {
        type: 'number',
        description: `返回条数，默认 ${HISTORY_DEFAULT_LIMIT}，上限 ${HISTORY_MAX_LIMIT}。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: '实际返回的条数' },
          messages: {
            type: 'array',
            required: true,
            description: '按时间正序排列的消息',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'string', required: true },
                sender: { type: 'string', required: true },
                content: { type: 'string', required: true },
                quoted: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const listed = value.messages
          .map((m) => {
            const quoted = m.quoted ? `\n  ↳ 引用了：${m.quoted}` : ''
            return `[${m.time}] ${m.sender}: ${m.content}${quoted}`
          })
          .join('\n')
        const body = value.count === 0 ? '没有查到符合条件的消息。' : listed
        return [{ type: 'text', text: `共 ${value.count} 条：\n${body}` }]
      },
    },
    async execute(args) {
      const limit = Math.min(
        Math.max(1, Math.floor(args.limit ?? HISTORY_DEFAULT_LIMIT)),
        HISTORY_MAX_LIMIT,
      )
      const since =
        args.since_minutes !== undefined && Number.isFinite(args.since_minutes)
          ? Date.now() - Math.max(0, args.since_minutes) * 60_000
          : undefined

      const rows = store.search({
        appId: config.appId,
        scope,
        peerId,
        ...(args.query ? { query: args.query } : {}),
        ...(args.sender ? { senderName: args.sender } : {}),
        ...(since !== undefined ? { since } : {}),
        limit,
        order: 'desc',
      })
      // search 是"由近及远"，返回给模型时按时间正序更好读
      rows.reverse()

      return {
        count: rows.length,
        messages: rows.map((row) => ({
          time: formatTime(row.ts),
          sender: row.senderName ?? row.senderId,
          content: truncate(row.content, PER_MESSAGE_CHARS),
          ...(row.quotedContent ? { quoted: truncate(row.quotedContent, PER_MESSAGE_CHARS) } : {}),
        })),
      }
    },
  })
}

export function createSendTool(deps: ToolDeps) {
  const { gateway, store, config, scope, peerId } = deps
  return defineTool({
    name: 'qqbot_send',
    description: '把一条消息发送到当前 QQ 群或单聊，内容按 markdown 渲染。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要发送的内容。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'integer', required: true, description: '实际发出的消息条数' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已发出 ${value.sent} 条消息到${scope === 'group' ? '群里' : '单聊'}。` },
      ],
    },
    async execute(args) {
      const sent = await gateway.send(scope, peerId, args.text)
      store.appendOutbound(config.appId, scope, peerId, args.text)
      return { sent }
    },
  })
}

export function createAgentTools(deps: ToolDeps) {
  return [createHistoryTool(deps), createSendTool(deps)]
}
