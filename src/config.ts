/**
 * 插件配置 Schema。
 *
 * 用 schemastery（dsh 全家桶统一的配置库）声明，dsh 在装配 profile 时会用
 * `cordis.patch.yml` 里的 config 字段填充它。
 */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** QQ 开放平台机器人 AppID */
  appId: string
  /** QQ 开放平台机器人 AppSecret */
  appSecret: string
  /**
   * 是否使用沙箱环境。开启后所有 HTTP/WebSocket 都指向
   * sandbox.api.sgroup.qq.com，正式环境用 api.sgroup.qq.com。
   */
  sandbox: boolean
  /** agent 的工作目录；不填则用进程 cwd */
  cwd?: string
  /**
   * 群白名单（group_openid）。
   *
   * **空数组 = 一个群都不放行**（fail closed）。装完必须显式列群 id 才会工作。
   * 不支持通配符：想开放就把 id 列全。
   */
  allowedGroups: string[]
  /**
   * 单聊白名单（user openid）。
   *
   * **空数组 = 一个都不放行**。想开单聊就把对方 openid 列进来。
   */
  allowedUsers: string[]
  /**
   * 发送者黑名单（openid）。
   *
   * 只拦「@ 机器人触发 agent」这一条路径，**不影响消息入库** ——
   * 黑名单里的人发言照样进历史库，只是不会唤醒 agent。
   * 不按昵称匹配：昵称可改、可重名，当安全边界不可靠。
   */
  blockedSenders: string[]
  /**
   * 历史库路径。不填则落在 `$DSH_HOME/storages/dsh-yashiro/history.db`。
   */
  historyDbPath?: string
  /** 单次 qqbot_history 查询默认返回条数 */
  historyDefaultLimit: number
  /** 单次 qqbot_history 查询允许返回的最大条数 */
  historyMaxLimit: number
  /** qqbot_send 单条消息最大字符数，超出自动切分 */
  sendChunkLimit: number
  /** 群聊 @ 时，附带告诉 agent「自你上次发言以来还有几条新消息」 */
  announceNewMessageCount: boolean
  /**
   * 触发 agent 的系统提示词片段。留空用内置默认值（见 prompt.ts）。
   * 这是 agent 知道「必须用 qqbot_send 回复」的唯一途径，谨慎修改。
   */
  systemPrompt?: string
  /** 调试日志 */
  debug: boolean
}

export const Config: Schema<Config> = Schema.object({
  appId: Schema.string().required(),
  appSecret: Schema.string().required(),
  sandbox: Schema.boolean().default(false),
  cwd: Schema.string(),
  allowedGroups: Schema.array(Schema.string()).default([]),
  allowedUsers: Schema.array(Schema.string()).default([]),
  blockedSenders: Schema.array(Schema.string()).default([]),
  historyDbPath: Schema.string(),
  historyDefaultLimit: Schema.number().default(30),
  historyMaxLimit: Schema.number().default(200),
  sendChunkLimit: Schema.number().default(4500),
  announceNewMessageCount: Schema.boolean().default(true),
  systemPrompt: Schema.string(),
  debug: Schema.boolean().default(false),
})
