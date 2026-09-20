/**
 * 挂给 agent 的两个工具。
 *
 * 两个工具都是 **agent-scoped** 的：它们通过闭包绑定到这个 agent 所属的那个
 * 群/单聊，agent 不需要（也不能）指定目标，避免它手滑发到别的群去。
 *
 * 注册发生在 `ctx.agents.create({ setup })` 的 setup 回调里，随 agent 一起
 * 建立、随 agent 一起销毁。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Config } from './config.js'
import type { YashiroGateway } from './gateway.js'
import type { HistoryStore } from './store.js'
import { describeAttachment } from './message-text.js'
import { formatTime, platformNowIso } from './time.js'

export interface ToolDeps {
  store: HistoryStore
  gateway: YashiroGateway
  config: Config
  scope: 'group' | 'c2c'
  peerId: string
}

/** 单条消息在工具结果里的最大字符数，避免一次查询把上下文撑爆 */
const PER_MESSAGE_CHARS = 400

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…（已截断）`
}

/** qqbot_history：让 agent 自己查群里的聊天记录 */
export function createHistoryTool(deps: ToolDeps) {
  const { store, config, scope, peerId } = deps
  return defineTool({
    name: 'qqbot_history',
    description:
      '查询当前群/单聊的历史聊天记录。群里所有人的发言都在库里，但不会自动进入你的上下文，' +
      '需要了解之前聊过什么时用这个工具查。不传任何参数则返回最近若干条。',
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
        description: `返回条数，默认 ${config.historyDefaultLimit}，上限 ${config.historyMaxLimit}。`,
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
        Math.max(1, Math.floor(args.limit ?? config.historyDefaultLimit)),
        config.historyMaxLimit,
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

/** qqbot_send：agent 唯一的发声通道 */
export function createSendTool(deps: ToolDeps) {
  const { gateway, store, config, scope, peerId } = deps
  return defineTool({
    name: 'qqbot_send',
    description:
      '把一条消息发到当前 QQ 群/单聊里。这是你唯一能让群友看到你说话的方式——' +
      '你的普通输出群友看不到，必须调用这个工具才会真正发出去。' +
      '内容较长时会自动切分成多条。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要发送的内容。写成在群里聊天的口吻，不要写成报告。',
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
      // 机器人自己说的话也记一笔，方便以后 agent 回忆「我上次说了什么」
      store.append({
        appId: config.appId,
        scope,
        peerId,
        messageId: `outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        senderId: 'SELF',
        senderName: '你（机器人）',
        content: args.text,
        mentionsBot: false,
        rawEventType: 'OUTBOUND',
        timestamp: platformNowIso(),
      })
      return { sent }
    },
  })
}

/** 一次性拿到两个工具 */
export function createAgentTools(deps: ToolDeps) {
  return [createHistoryTool(deps), createSendTool(deps)]
}
