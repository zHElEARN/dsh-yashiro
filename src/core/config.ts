/**
 * 插件配置 Schema，由 profile 的 `cordis.patch.yml` 填充。
 * 每一项的含义与默认值也写在 README 的「配置项」表里，两边必须对齐。
 */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** QQ 开放平台机器人 AppID */
  appId: string
  /** QQ 开放平台机器人 AppSecret */
  appSecret: string
  /** 开启后 HTTP/WebSocket 指向 sandbox.api.sgroup.qq.com */
  sandbox: boolean
  /** agent 的工作目录；留空用进程 cwd */
  cwd?: string
  /** 群白名单（group_openid）。空数组 = 一个群都不放行；不支持通配符，意图必须写死 */
  allowedGroups: string[]
  /** 单聊白名单（user openid）。空数组 = 一个都不放行 */
  allowedUsers: string[]
  /** 发送者黑名单（openid）。只拦 @ 触发，不影响入库；按 openid 匹配而非昵称 */
  blockedSenders: string[]
  /** 留空落在 `$DSH_HOME/storages/dsh-yashiro/history.db` */
  historyDbPath?: string
  /** @ 时是否附带告诉 agent「自你上次开口以来群里还有几条新消息」 */
  announceNewMessageCount: boolean
  /** 允许点审批按钮的 openid 白名单。空数组 = 群里任何人都能点，填了则平台侧和回执处各校验一次 */
  approvers: string[]
  /** 审批卡片无人处理多久后按「拒绝」收场（秒） */
  approvalTimeoutSeconds: number
  /** agent 跑回合时新 @ 进来的消息：steer 插队（下个 step 边界可见），queue 等下一个回合 */
  busyDelivery: 'steer' | 'queue'
  /** 打开后写 DEBUG 级文件日志 */
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
  announceNewMessageCount: Schema.boolean().default(true),
  approvers: Schema.array(Schema.string()).default([]),
  approvalTimeoutSeconds: Schema.number().default(300),
  busyDelivery: Schema.union([Schema.const('steer'), Schema.const('queue')]).default('steer'),
  debug: Schema.boolean().default(false),
})
