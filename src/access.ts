/**
 * 访问控制。
 *
 * 三条规则（都是明确确认过的）：
 *
 * 1. **白名单严格生效，空数组 = 一个都不放行**（fail closed）。
 *    群和单聊各有一个独立白名单，空即全禁 —— 装完必须显式配置才能工作。
 *    不支持任何通配符：想开放就把 id 列全，意图必须写死。
 * 2. **黑名单只按发送者 openid 匹配**（不用昵称：昵称可改、可重名，当安全边界不可靠）。
 *    黑名单**只拦 @ 触发**，不影响消息入库 —— 历史照常记录，只是不唤醒 agent。
 * 3. **`/id` 豁免指令**要求 **@ 机器人**，但绕过白名单与黑名单，由插件直接回复、不进 dsh。
 *    要求 @ 是为了避免误伤：群里有人随口打出 `/id` 不该触发机器人。
 *    这仍然能打破自举问题 —— 不知道 group openid 就没法配白名单，而 @ 是随时可做的。
 *
 * 这个模块是纯函数，便于自检覆盖（见 scripts/selfcheck.mjs）。
 */

/** `/id` 指令 */
export const ID_COMMAND = '/id'

/**
 * 判断一条消息是不是 `/id` 豁免指令。
 *
 * 两个条件都要满足：**@ 了机器人**，且整条消息（去掉首尾空白后）完全等于 `/id`。
 * 要求 @ 是为了避免误伤；带参数（如 `/id foo`）不触发。
 */
export function isIdCommand(content: string, mentionsBot: boolean): boolean {
  return mentionsBot && content.trim() === ID_COMMAND
}

export type ChatScope = 'group' | 'c2c'

/** 访问控制相关的配置切片 */
export interface AccessConfig {
  /** 群白名单（group_openid）；空数组 = 一个群都不放行 */
  allowedGroups: string[]
  /** 单聊白名单（user openid）；空数组 = 一个都不放行 */
  allowedUsers: string[]
  /** 发送者黑名单（openid）；只拦 @ 触发，不影响入库 */
  blockedSenders: string[]
}

export type AccessDecision =
  | { action: 'allow' }
  /** 这个会话整体没被放行 —— 消息入库后直接结束 */
  | { action: 'deny-peer'; reason: 'group-not-allowed' | 'c2c-not-allowed' }
  /** 会话放行了，但这个发送者在黑名单里 —— 消息入库，但不唤醒 agent */
  | { action: 'deny-sender'; reason: 'sender-blocked' }

/**
 * 判断一个会话 + 发送者是否被放行。
 *
 * 只在「是否唤醒 agent」这一步生效；消息入库不经过这里。
 */
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

/** `/id` 指令的回复文案：把当前会话 id 和发送者 openid 都报出来，方便配置访问控制 */
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
  lines.push(
    '',
    '—',
    '群 ID 填到 allowedGroups，你的 openid 填到 blockedSenders（黑名单）。',
    '两者都是空 = 全部拦截，必须显式配置。',
  )
  return lines.join('\n')
}
