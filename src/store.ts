/**
 * 群消息历史库。
 *
 * 设计要点（对应我们的架构决定）：
 * - **群里所有消息都落这里**，包括没 @ 机器人的那些。
 * - **只有 @ 机器人的消息才会进 agent 的上下文**；其余消息 agent 想看得自己调
 *   `qqbot_history` 工具来查。
 * - 用 node:sqlite（Node 22.5+ 内置），零原生依赖。
 * - 检索用 LIKE 而不是 FTS5：FTS5 的默认分词器对中文几乎没用，除非额外挂
 *   CJK 分词器。群消息以中文为主，LIKE 反而更可靠。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 附件元数据。
 *
 * 插件**只记录平台给的元信息，不下载文件、不做持久化** ——
 * 图片怎么看、什么时候下，全交给 agent 自己决定（QQ 的 URL 带时效，过期就算了）。
 * `from` 区分这份附件挂在哪条消息上：当前这条，还是被引用的那条。
 */
export interface AttachmentInfo {
  /** 平台给的 MIME 类型：image/jpeg、voice、video/mp4、file 等 */
  contentType: string
  /** 附件挂在当前消息上还是被引用的消息上 */
  from: 'current' | 'quoted'
  url?: string
  filename?: string
  size?: number
  width?: number
  height?: number
  /** 语音消息的平台转写文本（有的话直接用，不用下载） */
  asrText?: string
  /** 语音消息平台转码后的 WAV URL */
  voiceWavUrl?: string
}

/** 一条被记录下来的群/单聊消息 */
export interface StoredMessage {
  appId: string
  /** group = 群聊，c2c = 单聊 */
  scope: 'group' | 'c2c'
  /** 群 openid 或用户 openid */
  peerId: string
  /** 平台消息 ID */
  messageId: string
  /** 发送者 openid */
  senderId: string
  /** 发送者昵称 */
  senderName?: string
  /** 文本内容（已剥掉 <@...> 标记） */
  content: string
  /** 这条消息是否 @ 了机器人 */
  mentionsBot: boolean
  /** 被引用消息的内容（QQ 引用消息时平台会带上） */
  quotedContent?: string
  /** 附件元数据（当前消息的 + 被引用消息的，靠 `from` 区分） */
  attachments?: AttachmentInfo[]
  /** 原始事件类型 */
  rawEventType: string
  /** 平台时间戳（RFC3339） */
  timestamp: string
}

/** 一条查询结果 */
export interface HistoryRow extends StoredMessage {
  /** 自增主键，按时间递增 */
  seq: number
  /** epoch 毫秒，便于范围查询 */
  ts: number
}

export interface SearchOptions {
  appId: string
  scope?: 'group' | 'c2c'
  peerId?: string
  /** 关键词，匹配消息正文与引用正文 */
  query?: string
  /** 按发送者昵称过滤（模糊匹配） */
  senderName?: string
  /** 起始时间，epoch 毫秒 */
  since?: number
  /** 结束时间，epoch 毫秒 */
  until?: number
  /** 返回条数上限 */
  limit: number
  /** 排序方向，默认由近及远（desc） */
  order?: 'asc' | 'desc'
}

/** 默认历史库路径：$DSH_HOME/storages/dsh-yashiro/history.db */
export function defaultHistoryDbPath(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-yashiro', 'history.db')
}

export class HistoryStore {
  private readonly db: DatabaseSync
  /** 库文件路径（插件日志会写到同目录下） */
  readonly path: string

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id        TEXT    NOT NULL,
        scope         TEXT    NOT NULL,
        peer_id       TEXT    NOT NULL,
        message_id    TEXT    NOT NULL,
        sender_id     TEXT    NOT NULL,
        sender_name   TEXT,
        content       TEXT    NOT NULL,
        mentions_bot  INTEGER NOT NULL DEFAULT 0,
        quoted_content TEXT,
        attachments   TEXT,
        raw_event_type TEXT   NOT NULL,
        timestamp     TEXT    NOT NULL,
        ts            INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msgid ON messages(app_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(app_id, peer_id, ts);
    `)
  }

  /** 落一条消息；message_id 重复时静默忽略（平台可能重推） */
  append(msg: StoredMessage): void {
    const ts = Date.parse(msg.timestamp)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (app_id, scope, peer_id, message_id, sender_id, sender_name, content,
            mentions_bot, quoted_content, attachments, raw_event_type, timestamp, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.appId,
        msg.scope,
        msg.peerId,
        msg.messageId,
        msg.senderId,
        msg.senderName ?? null,
        msg.content,
        msg.mentionsBot ? 1 : 0,
        msg.quotedContent ?? null,
        msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
        msg.rawEventType,
        msg.timestamp,
        Number.isFinite(ts) ? ts : Date.now(),
      )
  }

  /** 按条件检索 */
  search(opts: SearchOptions): HistoryRow[] {
    const where: string[] = ['app_id = ?']
    const params: Array<string | number> = [opts.appId]

    if (opts.scope) {
      where.push('scope = ?')
      params.push(opts.scope)
    }
    if (opts.peerId) {
      where.push('peer_id = ?')
      params.push(opts.peerId)
    }
    if (opts.query) {
      where.push('(content LIKE ? OR quoted_content LIKE ?)')
      const like = `%${opts.query}%`
      params.push(like, like)
    }
    if (opts.senderName) {
      where.push('sender_name LIKE ?')
      params.push(`%${opts.senderName}%`)
    }
    if (opts.since !== undefined) {
      where.push('ts >= ?')
      params.push(opts.since)
    }
    if (opts.until !== undefined) {
      where.push('ts <= ?')
      params.push(opts.until)
    }

    const order = opts.order === 'asc' ? 'ASC' : 'DESC'
    params.push(Math.max(1, Math.floor(opts.limit)))

    const rows = this.db
      .prepare(
        `SELECT seq, app_id, scope, peer_id, message_id, sender_id, sender_name, content,
                mentions_bot, quoted_content, attachments, raw_event_type, timestamp, ts
           FROM messages
          WHERE ${where.join(' AND ')}
          ORDER BY ts ${order}, seq ${order}
          LIMIT ?`,
      )
      .all(...params)

    return rows.map(toHistoryRow)
  }

  /** 某个会话最近 n 条（含机器人自己的发言，方便 agent 回忆上下文） */
  recent(appId: string, peerId: string, limit: number): HistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT seq, app_id, scope, peer_id, message_id, sender_id, sender_name, content,
                  mentions_bot, quoted_content, attachments, raw_event_type, timestamp, ts
             FROM messages
            WHERE app_id = ? AND peer_id = ?
            ORDER BY ts DESC, seq DESC
            LIMIT ?
         ) ORDER BY ts ASC, seq ASC`,
      )
      .all(appId, peerId, Math.max(1, Math.floor(limit)))
    return rows.map(toHistoryRow)
  }

  /** 自某个时间点以来、某个会话里、@ 过机器人之外的消息条数 */
  countSince(appId: string, peerId: string, sinceMs: number, excludeMentions = false): number {
    const sql = excludeMentions
      ? 'SELECT COUNT(*) AS n FROM messages WHERE app_id = ? AND peer_id = ? AND ts > ? AND mentions_bot = 0'
      : 'SELECT COUNT(*) AS n FROM messages WHERE app_id = ? AND peer_id = ? AND ts > ?'
    const row = this.db.prepare(sql).get(appId, peerId, sinceMs) as { n: number } | undefined
    return row?.n ?? 0
  }

  /** 该会话里最后一条消息的时间（epoch ms），没有则返回 undefined */
  lastTs(appId: string, peerId: string): number | undefined {
    const row = this.db
      .prepare('SELECT MAX(ts) AS ts FROM messages WHERE app_id = ? AND peer_id = ?')
      .get(appId, peerId) as { ts: number | null } | undefined
    return row?.ts ?? undefined
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 已被关闭 */
    }
  }
}

function toHistoryRow(row: Record<string, unknown>): HistoryRow {
  let attachments: AttachmentInfo[] | undefined
  if (typeof row.attachments === 'string' && row.attachments.length > 0) {
    try {
      attachments = JSON.parse(row.attachments) as AttachmentInfo[]
    } catch {
      attachments = undefined
    }
  }
  return {
    seq: Number(row.seq),
    appId: String(row.app_id),
    scope: String(row.scope) === 'c2c' ? 'c2c' : 'group',
    peerId: String(row.peer_id),
    messageId: String(row.message_id),
    senderId: String(row.sender_id),
    senderName: row.sender_name === null || row.sender_name === undefined ? undefined : String(row.sender_name),
    content: String(row.content),
    mentionsBot: Number(row.mentions_bot) === 1,
    quotedContent:
      row.quoted_content === null || row.quoted_content === undefined ? undefined : String(row.quoted_content),
    attachments,
    rawEventType: String(row.raw_event_type),
    timestamp: String(row.timestamp),
    ts: Number(row.ts),
  }
}
