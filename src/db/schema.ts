/**
 * 历史库的表定义 —— schema 的唯一事实源。
 *
 * 改完这里必须跑 `pnpm db:generate` 生成迁移：产物在 `drizzle/`，随包一起发布，插件启动时
 * 自动把库推到最新版本。**只改这个文件不生成迁移 = 用户机器上的库还是旧 schema。**
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 两个 JSON 列（`mentions` / `attachments`）刻意用裸 `text()` 而不是 drizzle 的
 * `{ mode: "json" }`：后者读回坏数据时会抛，而历史库的约定是「坏数据当没有」
 * （见 store.ts 的 parseJson），一条烂行不该让整个检索挂掉。序列化在 store.ts 里手工做。
 *
 * 群里所有消息（含没 @ 机器人的），只有 @ 过的会进 agent 上下文
 */
export const messages = sqliteTable(
  "messages",
  {
    /** 自增主键，也是给模型看的 `#id` */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    appId: text("app_id").notNull(),
    scope: text("scope").notNull(),
    /** 群 openid 或用户 openid */
    peerId: text("peer_id").notNull(),
    messageId: text("message_id").notNull(),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name"),
    /** `@openid` 已换成 `@昵称`、表情已收敛成 `[表情]` */
    content: text("content").notNull(),
    /** 这条消息是不是冲着机器人说的：群里是 @ 了它，单聊恒为真 */
    mentionsBot: integer("mentions_bot", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 这条消息 @ 了谁（JSON） */
    mentions: text("mentions"),
    /** QQ 引用消息时平台会带上 */
    quotedContent: text("quoted_content"),
    /** 平台给这条消息的序号，用来解析「谁引用了谁」 */
    msgIdx: text("msg_idx"),
    /** 这条消息引用的那条消息的平台序号 */
    quotedMsgIdx: text("quoted_msg_idx"),
    /** 只记平台给的元信息，不下载文件（JSON） */
    attachments: text("attachments"),
    rawEventType: text("raw_event_type").notNull(),
    /** 平台时间戳（RFC3339），展示用 */
    timestamp: text("timestamp").notNull(),
    /** epoch 毫秒，过滤与排序用 */
    ts: integer("ts").notNull(),
  },
  (t) => [
    // 平台可能重推同一条消息，幂等全靠这个唯一索引
    uniqueIndex("idx_messages_msgid").on(t.appId, t.messageId),
    index("idx_messages_peer_ts").on(t.appId, t.peerId, t.ts),
    index("idx_messages_msgidx").on(t.appId, t.peerId, t.msgIdx),
  ],
);

/** 一个 QQ 会话（群/单聊）内的第 epoch 条 dsh 会话，其中最多一条 is_current */
export const sessionBindings = sqliteTable(
  "session_bindings",
  {
    appId: text("app_id").notNull(),
    scope: text("scope").notNull(),
    peerId: text("peer_id").notNull(),
    /** 该 QQ 会话内的自增序号，参与 SessionId 派生 */
    epoch: integer("epoch").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: integer("created_at").notNull(),
    /** 最近一次投递的时间，会话列表按它倒序 */
    updatedAt: integer("updated_at").notNull(),
    isCurrent: integer("is_current", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.scope, t.peerId, t.epoch] }),
    index("idx_bindings_current").on(t.appId, t.scope, t.peerId, t.isCurrent),
  ],
);
