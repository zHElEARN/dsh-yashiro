/**
 * 群消息历史库：群里所有消息（含没 @ 机器人的）都落这里，只有 @ 过的会进 agent 上下文。
 *
 * 用 node:sqlite（Node 22.5+ 内置）零原生依赖；检索用 LIKE 而非 FTS5 —— FTS5 默认
 * 分词器对中文几乎没用，群消息又以中文为主。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { platformNowIso } from "./core/time.js";
import type { ChatKey, MentionInfo, Scope } from "./core/types.js";

/** 只记录平台给的元信息，不下载文件、不持久化 */
export interface AttachmentInfo {
  /** MIME 类型：image/jpeg、voice、video/mp4、file 等 */
  contentType: string;
  /** 附件挂在当前消息上，还是被引用的那条消息上 */
  from: "current" | "quoted";
  /** 语音存的是平台转码后的 WAV */
  url?: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  /** 语音的平台转写文本 */
  asrText?: string;
}

export interface StoredMessage {
  appId: string;
  scope: Scope;
  /** 群 openid 或用户 openid */
  peerId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  /** `@openid` 已换成 `@昵称`、表情已收敛成 `[表情]` */
  content: string;
  /** 这条消息是不是冲着机器人说的：群里是 @ 了它，单聊恒为真 */
  mentionsBot: boolean;
  /** 这条消息 @ 了谁 */
  mentions?: MentionInfo[];
  /** QQ 引用消息时平台会带上 */
  quotedContent?: string;
  /** 平台给这条消息的序号，用来解析"谁引用了谁" */
  msgIdx?: string;
  /** 这条消息引用的那条消息的平台序号 */
  quotedMsgIdx?: string;
  attachments?: AttachmentInfo[];
  rawEventType: string;
  /** 平台时间戳（RFC3339） */
  timestamp: string;
}

/** 比 StoredMessage 多几个查询用的列 */
export interface HistoryRow extends StoredMessage {
  /** 自增主键，也是给模型看的 `#id` */
  seq: number;
  /** epoch 毫秒 */
  ts: number;
  /** 被引用那条消息的说话人；库里查不到时为 undefined */
  quotedSenderId?: string;
  quotedSenderName?: string;
}

/** 一条消息的过滤条件，search / count 共用 */
export interface MessageFilter {
  appId: string;
  scope?: Scope;
  peerId?: string;
  /** 子串匹配正文、引用正文与附件（文件名/URL） */
  query?: string;
  /** 子串匹配发送者昵称或 openid */
  sender?: string;
  /** epoch 毫秒 */
  since?: number;
  /** epoch 毫秒 */
  until?: number;
  /** 只看 seq 小于它的 */
  beforeSeq?: number;
  /** 只看 seq 大于它的 */
  afterSeq?: number;
  /** 只看（不）@ 过机器人的 */
  mentionsMe?: boolean;
}

export interface SearchOptions extends MessageFilter {
  limit: number;
  /** 默认 desc，由近及远（按 seq，也就是入库顺序） */
  order?: "asc" | "desc";
}

/** 整个 QQ 会话的规模，用来在结果头部给出"地图" */
export interface MessageStats {
  total: number;
  firstTs?: number;
  lastTs?: number;
}

/** 一条会话绑定：QQ 会话内第 epoch 条 dsh 会话 */
export interface SessionBinding {
  /** 该 QQ 会话内的自增序号，参与 SessionId 派生 */
  epoch: number;
  sessionId: string;
  createdAt: number;
  /** 最近一次投递的时间，列表按它倒序 */
  updatedAt: number;
}

export interface SessionPage {
  sessions: SessionBinding[];
  total: number;
}

/** 默认落在 $DSH_HOME/storages/dsh-yashiro/history.db */
export function defaultHistoryDbPath(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(home, "storages", "dsh-yashiro", "history.db");
}

export class HistoryStore {
  private readonly db: DatabaseSync;
  /** 插件日志会写到同目录下 */
  readonly path: string;
  /** 见 now() —— 保证绑定表的时间戳严格递增 */
  private lastStamp = 0;

  /**
   * 单调递增的毫秒时间戳。
   *
   * 列表是按 updated_at 倒序排的，而 Date.now() 只有毫秒精度：同一毫秒里 touch 两条
   * 会拿到相同的时间戳，排序就变成随机的。这里保证每次调用都比上一次大（至少 +1ms，
   * 只是排序用的逻辑时钟）。
   */
  private now(): number {
    const ms = Date.now();
    this.lastStamp = ms > this.lastStamp ? ms : this.lastStamp + 1;
    return this.lastStamp;
  }

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
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
        mentions      TEXT,
        quoted_content TEXT,
        msg_idx       TEXT,
        quoted_msg_idx TEXT,
        attachments   TEXT,
        raw_event_type TEXT   NOT NULL,
        timestamp     TEXT    NOT NULL,
        ts            INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msgid ON messages(app_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(app_id, peer_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_msgidx ON messages(app_id, peer_id, msg_idx);

      CREATE TABLE IF NOT EXISTS session_bindings (
        app_id      TEXT    NOT NULL,
        scope       TEXT    NOT NULL,
        peer_id     TEXT    NOT NULL,
        epoch       INTEGER NOT NULL,
        session_id  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        is_current  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (app_id, scope, peer_id, epoch)
      );
      CREATE INDEX IF NOT EXISTS idx_bindings_current ON session_bindings(app_id, scope, peer_id, is_current);
    `);
  }

  /**
   * 落一条消息；message_id 重复时静默忽略（平台可能重推）。
   *
   * @returns 这一行的 seq（重复推送时是已存在那行的 seq）。插件用它记住"上次投递给
   * agent 的是哪条"。
   */
  append(msg: StoredMessage): number | undefined {
    const ts = Date.parse(msg.timestamp);
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (app_id, scope, peer_id, message_id, sender_id, sender_name, content,
            mentions_bot, mentions, quoted_content, msg_idx, quoted_msg_idx,
            attachments, raw_event_type, timestamp, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        msg.mentions?.length ? JSON.stringify(msg.mentions) : null,
        msg.quotedContent ?? null,
        msg.msgIdx ?? null,
        msg.quotedMsgIdx ?? null,
        msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
        msg.rawEventType,
        msg.timestamp,
        Number.isFinite(ts) ? ts : Date.now(),
      );

    if (info.changes > 0) return Number(info.lastInsertRowid);

    // 被 INSERT OR IGNORE 忽略了（平台重推）：lastInsertRowid 是上一条的，不能信
    const existing = this.db
      .prepare("SELECT seq FROM messages WHERE app_id = ? AND message_id = ?")
      .get(msg.appId, msg.messageId) as { seq: number } | undefined;
    return existing === undefined ? undefined : Number(existing.seq);
  }

  /**
   * 机器人自己发出的消息也记一笔，历史里才看得到双方说过的话。
   *
   * message_id 是合成的：出站没有平台 id，而 `(app_id, message_id)` 是唯一索引，
   * 用 uuid 才不会让同一毫秒内的两条发言互相顶掉。
   */
  appendOutbound(
    key: ChatKey,
    content: string,
    attachments?: AttachmentInfo[],
  ): void {
    this.append({
      ...key,
      messageId: `outbound-${randomUUID()}`,
      senderId: "SELF",
      senderName: "你（机器人）",
      content,
      mentionsBot: false,
      ...(attachments?.length ? { attachments } : {}),
      rawEventType: "OUTBOUND",
      timestamp: platformNowIso(),
    });
  }

  // ── 会话绑定：一个 QQ 会话（群/单聊）可以有多条 dsh 会话，其中一条是 current ──

  /** 当前会话；这个群/单聊还没建过任何会话时返回 undefined */
  getCurrentSession(key: ChatKey): SessionBinding | undefined {
    const row = this.db
      .prepare(
        `SELECT app_id, scope, peer_id, epoch, session_id, created_at, updated_at
           FROM session_bindings
          WHERE app_id = ? AND scope = ? AND peer_id = ? AND is_current = 1`,
      )
      .get(key.appId, key.scope, key.peerId);
    return row === undefined ? undefined : toSessionBinding(row);
  }

  /**
   * 下一个可用的 epoch。
   *
   * 是 `MAX(epoch) + 1` 而不是「会话条数 + 1」：会话万一被删掉一条，条数就会跟已有的
   * epoch 撞上，派生出的 SessionId 会指向别的会话。
   */
  nextEpoch(key: ChatKey): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(epoch), 0) AS max_epoch
           FROM session_bindings WHERE app_id = ? AND scope = ? AND peer_id = ?`,
      )
      .get(key.appId, key.scope, key.peerId) as
      | { max_epoch: number }
      | undefined;
    return Number(row?.max_epoch ?? 0) + 1;
  }

  /** 新建一条会话（epoch 取当前最大值 +1）并切成 current，返回新绑定 */
  createSession(key: ChatKey, sessionId: string): SessionBinding {
    const epoch = this.nextEpoch(key);
    const now = this.now();

    this.db
      .prepare(
        `INSERT INTO session_bindings
           (app_id, scope, peer_id, epoch, session_id, created_at, updated_at, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(key.appId, key.scope, key.peerId, epoch, sessionId, now, now);

    this.setCurrentSession(key, epoch);
    return { epoch, sessionId, createdAt: now, updatedAt: now };
  }

  /**
   * 切换 current。先确认目标存在再清旧标记 —— 否则目标不存在时会把现有指针一起清掉，
   * 群的当前会话变成「无」，@ 就不再回应了。
   */
  setCurrentSession(key: ChatKey, epoch: number): boolean {
    const { appId, scope, peerId } = key;
    const exists = this.db
      .prepare(
        "SELECT 1 AS ok FROM session_bindings WHERE app_id = ? AND scope = ? AND peer_id = ? AND epoch = ?",
      )
      .get(appId, scope, peerId, epoch);
    if (exists === undefined) return false;

    this.db
      .prepare(
        "UPDATE session_bindings SET is_current = 0 WHERE app_id = ? AND scope = ? AND peer_id = ?",
      )
      .run(appId, scope, peerId);
    this.db
      .prepare(
        `UPDATE session_bindings SET is_current = 1, updated_at = ?
          WHERE app_id = ? AND scope = ? AND peer_id = ? AND epoch = ?`,
      )
      .run(this.now(), appId, scope, peerId, epoch);
    return true;
  }

  /** 刷新「最近使用」；列表就是按它倒序排的，每次投递后都要调 */
  touchSession(key: ChatKey, epoch: number): void {
    this.db
      .prepare(
        `UPDATE session_bindings SET updated_at = ?
          WHERE app_id = ? AND scope = ? AND peer_id = ? AND epoch = ?`,
      )
      .run(this.now(), key.appId, key.scope, key.peerId, epoch);
  }

  /** 某个群/单聊的全部会话，按最近使用倒序；page 从 1 开始 */
  listSessions(key: ChatKey, page: number, perPage: number): SessionPage {
    const { appId, scope, peerId } = key;
    const where = "app_id = ? AND scope = ? AND peer_id = ?";
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_bindings WHERE ${where}`)
      .get(appId, scope, peerId) as { n: number } | undefined;

    const rows = this.db
      .prepare(
        `SELECT app_id, scope, peer_id, epoch, session_id, created_at, updated_at
           FROM session_bindings
          WHERE ${where}
          ORDER BY updated_at DESC, epoch DESC
          LIMIT ? OFFSET ?`,
      )
      .all(appId, scope, peerId, perPage, (page - 1) * perPage);

    return {
      sessions: rows.map(toSessionBinding),
      total: Number(countRow?.n ?? 0),
    };
  }

  /**
   * 取一段消息。
   *
   * **按 `seq` 而不是 `ts` 排序**：游标（beforeSeq / afterSeq）与"还有多少条"都建立在
   * `seq` 上，窗口排序必须跟着它，否则一旦有消息晚到（seq 与 ts 不同序），翻页就会
   * 出现重叠或空洞。`ts` 只负责展示与时间过滤。
   */
  search(opts: SearchOptions): HistoryRow[] {
    const { where, params } = buildFilter(opts);
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const all = [...params, Math.max(1, Math.floor(opts.limit))];

    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS}
           FROM messages m
           LEFT JOIN messages q
             ON q.app_id = m.app_id AND q.peer_id = m.peer_id
            AND q.msg_idx = m.quoted_msg_idx
          WHERE ${where.join(" AND ")}
          ORDER BY m.seq ${order}
          LIMIT ?`,
      )
      .all(...all);

    return rows.map(toHistoryRow);
  }

  /** 同一组过滤条件下的条数，用来告诉模型"还有多少条没取" */
  count(opts: MessageFilter): number {
    const { where, params } = buildFilter(opts);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m WHERE ${where.join(" AND ")}`,
      )
      .get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 整个 QQ 会话的规模（不带任何过滤），结果头部的"地图"用它 */
  stats(key: ChatKey): MessageStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
           FROM messages WHERE app_id = ? AND scope = ? AND peer_id = ?`,
      )
      .get(key.appId, key.scope, key.peerId) as
      | { n: number; first_ts: number | null; last_ts: number | null }
      | undefined;
    return {
      total: Number(row?.n ?? 0),
      ...(row?.first_ts === null || row?.first_ts === undefined
        ? {}
        : { firstTs: Number(row.first_ts) }),
      ...(row?.last_ts === null || row?.last_ts === undefined
        ? {}
        : { lastTs: Number(row.last_ts) }),
    };
  }

  /** 该会话自某个时间点以来有多少条消息；excludeMentions 为真时只数非 @ 的 */
  countSince(key: ChatKey, sinceMs: number, excludeMentions = false): number {
    const sql = excludeMentions
      ? "SELECT COUNT(*) AS n FROM messages WHERE app_id = ? AND peer_id = ? AND ts > ? AND mentions_bot = 0"
      : "SELECT COUNT(*) AS n FROM messages WHERE app_id = ? AND peer_id = ? AND ts > ?";
    const row = this.db.prepare(sql).get(key.appId, key.peerId, sinceMs) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已被关闭 */
    }
  }
}

/** LIKE 的通配符转义：`%`、`_`、`\` 都按字面量处理，模型给什么就找什么 */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** search 取的列；引用者两列来自自连接 */
const ROW_COLUMNS = `m.seq, m.app_id, m.scope, m.peer_id, m.message_id, m.sender_id,
        m.sender_name, m.content, m.mentions_bot, m.mentions, m.quoted_content,
        m.msg_idx, m.quoted_msg_idx, m.attachments, m.raw_event_type, m.timestamp, m.ts,
        q.sender_id AS quoted_sender_id, q.sender_name AS quoted_sender_name`;

/**
 * 过滤条件 → WHERE 片段。
 *
 * search 与 count 共用同一套：两边要是走岔了，结果头部那句"还有 N 条"就是错的。
 */
function buildFilter(opts: MessageFilter): {
  where: string[];
  params: Array<string | number>;
} {
  const where: string[] = ["m.app_id = ?"];
  const params: Array<string | number> = [opts.appId];

  if (opts.scope) {
    where.push("m.scope = ?");
    params.push(opts.scope);
  }
  if (opts.peerId) {
    where.push("m.peer_id = ?");
    params.push(opts.peerId);
  }
  if (opts.query) {
    // 附件是 JSON 列，整列 LIKE 就等于匹配文件名与 URL
    where.push(
      "(m.content LIKE ? ESCAPE '\\' OR m.quoted_content LIKE ? ESCAPE '\\' OR m.attachments LIKE ? ESCAPE '\\')",
    );
    const like = likePattern(opts.query);
    params.push(like, like, like);
  }
  if (opts.sender) {
    // 昵称取不到时（单聊）只能靠 openid，所以两边都匹配
    where.push(
      "(m.sender_name LIKE ? ESCAPE '\\' OR m.sender_id LIKE ? ESCAPE '\\')",
    );
    const like = likePattern(opts.sender);
    params.push(like, like);
  }
  if (opts.since !== undefined) {
    where.push("m.ts >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push("m.ts <= ?");
    params.push(opts.until);
  }
  if (opts.beforeSeq !== undefined) {
    where.push("m.seq < ?");
    params.push(opts.beforeSeq);
  }
  if (opts.afterSeq !== undefined) {
    where.push("m.seq > ?");
    params.push(opts.afterSeq);
  }
  if (opts.mentionsMe !== undefined) {
    where.push("m.mentions_bot = ?");
    params.push(opts.mentionsMe ? 1 : 0);
  }

  return { where, params };
}

function toSessionBinding(row: Record<string, unknown>): SessionBinding {
  return {
    epoch: Number(row.epoch),
    sessionId: String(row.session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** JSON 列读回来；空值或坏数据都当没有 */
function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function toHistoryRow(row: Record<string, unknown>): HistoryRow {
  return {
    seq: Number(row.seq),
    appId: String(row.app_id),
    scope: String(row.scope) === "c2c" ? "c2c" : "group",
    peerId: String(row.peer_id),
    messageId: String(row.message_id),
    senderId: String(row.sender_id),
    senderName:
      row.sender_name === null || row.sender_name === undefined
        ? undefined
        : String(row.sender_name),
    content: String(row.content),
    mentionsBot: Number(row.mentions_bot) === 1,
    mentions: parseJson<MentionInfo[]>(row.mentions),
    quotedContent:
      row.quoted_content === null || row.quoted_content === undefined
        ? undefined
        : String(row.quoted_content),
    msgIdx:
      row.msg_idx === null || row.msg_idx === undefined
        ? undefined
        : String(row.msg_idx),
    quotedMsgIdx:
      row.quoted_msg_idx === null || row.quoted_msg_idx === undefined
        ? undefined
        : String(row.quoted_msg_idx),
    attachments: parseJson<AttachmentInfo[]>(row.attachments),
    rawEventType: String(row.raw_event_type),
    timestamp: String(row.timestamp),
    ts: Number(row.ts),
    ...(row.quoted_sender_id === null || row.quoted_sender_id === undefined
      ? {}
      : { quotedSenderId: String(row.quoted_sender_id) }),
    ...(row.quoted_sender_name === null || row.quoted_sender_name === undefined
      ? {}
      : { quotedSenderName: String(row.quoted_sender_name) }),
  };
}
