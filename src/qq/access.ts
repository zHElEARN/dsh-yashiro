/**
 * 访问控制（纯函数，不碰 QQ 也不碰 dsh）。
 *
 * 三条规则都是刻意选择的：白名单 fail closed（空数组 = 全禁）、黑名单只按 openid
 * 匹配且只拦唤醒不影响入库、`/id` 指令绕过全部访问控制以打破配置自举的死循环。
 */

export const ID_COMMAND = '/id'

/** 要求 @ 机器人是为了防误伤：群里有人随口打出 `/id` 不该触发回复 */
export function isIdCommand(content: string, mentionsBot: boolean): boolean {
  return mentionsBot && content.trim() === ID_COMMAND
}

export type ChatScope = 'group' | 'c2c'

export interface AccessConfig {
  allowedGroups: string[]
  allowedUsers: string[]
  /** 只拦 @ 触发，不影响消息入库 */
  blockedSenders: string[]
}

export type AccessDecision =
  | { action: 'allow' }
  | { action: 'deny-peer'; reason: 'group-not-allowed' | 'c2c-not-allowed' }
  | { action: 'deny-sender'; reason: 'sender-blocked' }

/** 只在「是否唤醒 agent」这一步生效；消息入库不经过这里 */
export function decideAccess(
  msg: { scope: ChatScope; peerId: string; senderId: string },
  config: AccessConfig,
): AccessDecision {
  if (msg.scope === 'group') {
    if (!config.allowedGroups.includes(msg.peerId)) {
      return { action: 'deny-peer', reason: 'group-not-allowed' }
    }
  } else if (!config.allowedUsers.includes(msg.peerId)) {
    return { action: 'deny-peer', reason: 'c2c-not-allowed' }
  }

  if (config.blockedSenders.includes(msg.senderId)) {
    return { action: 'deny-sender', reason: 'sender-blocked' }
  }

  return { action: 'allow' }
}

/** `/id` 的回复文案：报出会话 id 和发送者 openid，并指明该填哪个配置项 */
export function buildIdReply(msg: {
  scope: ChatScope
  peerId: string
  senderId: string
  senderName?: string
}): string {
  const lines: string[] = []
  if (msg.scope === 'group') {
    lines.push('群 ID（group_openid）：', msg.peerId, '', '你的 openid：', msg.senderId)
  } else {
    lines.push('单聊 ID（user openid）：', msg.peerId, '', '你的 openid：', msg.senderId)
  }
  if (msg.senderName) {
    lines.push('', `昵称：${msg.senderName}`)
  }
  lines.push('', '—')
  if (msg.scope === 'group') {
    lines.push('把群 ID 填到 allowedGroups 才会放行这个群（空 = 所有群都不放行）。')
  } else {
    lines.push(
      '把你的 openid 填到 allowedUsers 才会放行这个单聊（空 = 所有单聊都不放行）。',
      '群里的普通成员不需要任何配置，能配的只有群 ID。',
    )
  }
  return lines.join('\n')
}
