/**
 * 群消息历史库：群里所有消息（含没 @ 机器人的）都落这里，只有 @ 过的会进 agent 上下文。
 *
 * 驱动是 node:sqlite（Node 内置）零原生依赖；表结构定义在 `db/schema.ts`（唯一事实源），
 * 建库与升级由 `db/index.ts` 里的 drizzle 迁移完成。检索用 LIKE 而非 FTS5 —— FTS5 默认
 * 分词器对中文几乎没用，群消息又以中文为主。
 *
 * 本文件对外只暴露 HistoryStore 与下面这些类型，调用方（index / agent / qq 各层）不该看到 drizzle。
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  lt,
  lte,
  max,
  min,
  type SQL,
  sql,
  count as sqlCount,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { platformNowIso } from "./core/time.js";
import type { ChatKey, MentionInfo, Scope } from "./core/types.js";
import { type HistoryDb, openHistoryDb } from "./db/index.js";
import { messages, sessionBindings } from "./db/schema.js";

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
  private readonly db: HistoryDb;
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

  /** 打开库并把 schema 迁移到最新；建目录、WAL、迁移都在 db/index.ts 里 */
  constructor(path: string) {
    this.path = path;
    this.db = openHistoryDb(path);
  }

  /**
   * 落一条消息；message_id 重复时静默忽略（平台可能重推）。
   *
   * @returns 这一行的 seq（重复推送时是已存在那行的 seq）。插件用它记住"上次投递给
   * agent 的是哪条"。
   */
  append(msg: StoredMessage): number | undefined {
    const ts = Date.parse(msg.timestamp);
    const inserted = this.db
      .insert(messages)
      .values({
        appId: msg.appId,
        scope: msg.scope,
        peerId: msg.peerId,
        messageId: msg.messageId,
        senderId: msg.senderId,
        senderName: msg.senderName ?? null,
        content: msg.content,
        mentionsBot: msg.mentionsBot,
        mentions: msg.mentions?.length ? JSON.stringify(msg.mentions) : null,
        quotedContent: msg.quotedContent ?? null,
        msgIdx: msg.msgIdx ?? null,
        quotedMsgIdx: msg.quotedMsgIdx ?? null,
        attachments: msg.attachments?.length
          ? JSON.stringify(msg.attachments)
          : null,
        rawEventType: msg.rawEventType,
        timestamp: msg.timestamp,
        ts: Number.isFinite(ts) ? ts : Date.now(),
      })
      // 撞上 (app_id, message_id) 唯一索引就当没发生，配合 returning 判断到底插没插进去
      .onConflictDoNothing()
      .returning({ seq: messages.seq })
      .all();

    const row = inserted[0];
    if (row !== undefined) return Number(row.seq);

    // 被忽略的（平台重推）走这里：补一次查询拿到已存在那行的 seq
    const existing = this.db
      .select({ seq: messages.seq })
      .from(messages)
      .where(
        and(
          eq(messages.appId, msg.appId),
          eq(messages.messageId, msg.messageId),
        ),
      )
      .get();
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
      .select(BINDING_COLUMNS)
      .from(sessionBindings)
      .where(and(bindingKeyFilter(key), eq(sessionBindings.isCurrent, true)))
      .get();
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
      .select({ maxEpoch: max(sessionBindings.epoch) })
      .from(sessionBindings)
      .where(bindingKeyFilter(key))
      .get();
    return Number(row?.maxEpoch ?? 0) + 1;
  }

  /**
   * 新建一条会话（epoch 取当前最大值 +1）并切成 current，返回新绑定。
   *
   * 取号、插入、清旧 current、标记新 current 在一个事务里 —— 分开做的话两个进程
   * 同时建会话会撞 epoch（主键冲突）或留下两条 current。
   */
  createSession(key: ChatKey, sessionId: string): SessionBinding {
    const now = this.now();

    const epoch = this.db.transaction((tx) => {
      const row = tx
        .select({ maxEpoch: max(sessionBindings.epoch) })
        .from(sessionBindings)
        .where(bindingKeyFilter(key))
        .get();
      const next = Number(row?.maxEpoch ?? 0) + 1;

      tx.insert(sessionBindings)
        .values({
          ...key,
          epoch: next,
          sessionId,
          createdAt: now,
          updatedAt: now,
          isCurrent: false,
        })
        .run();

      tx.update(sessionBindings)
        .set({ isCurrent: false })
        .where(bindingKeyFilter(key))
        .run();
      tx.update(sessionBindings)
        .set({ isCurrent: true, updatedAt: this.now() })
        .where(and(bindingKeyFilter(key), eq(sessionBindings.epoch, next)))
        .run();

      return next;
    });

    return { epoch, sessionId, createdAt: now, updatedAt: now };
  }

  /**
   * 切换 current。先确认目标存在再清旧标记 —— 否则目标不存在时会把现有指针一起清掉，
   * 群的当前会话变成「无」，@ 就不再回应了。
   */
  setCurrentSession(key: ChatKey, epoch: number): boolean {
    return this.db.transaction((tx) => {
      const target = tx
        .select({ epoch: sessionBindings.epoch })
        .from(sessionBindings)
        .where(and(bindingKeyFilter(key), eq(sessionBindings.epoch, epoch)))
        .get();
      if (target === undefined) return false;

      tx.update(sessionBindings)
        .set({ isCurrent: false })
        .where(bindingKeyFilter(key))
        .run();
      tx.update(sessionBindings)
        .set({ isCurrent: true, updatedAt: this.now() })
        .where(and(bindingKeyFilter(key), eq(sessionBindings.epoch, epoch)))
        .run();
      return true;
    });
  }

  /** 刷新「最近使用」；列表就是按它倒序排的，每次投递后都要调 */
  touchSession(key: ChatKey, epoch: number): void {
    this.db
      .update(sessionBindings)
      .set({ updatedAt: this.now() })
      .where(and(bindingKeyFilter(key), eq(sessionBindings.epoch, epoch)))
      .run();
  }

  /** 某个群/单聊的全部会话，按最近使用倒序；page 从 1 开始 */
  listSessions(key: ChatKey, page: number, perPage: number): SessionPage {
    const filter = bindingKeyFilter(key);
    const countRow = this.db
      .select({ n: sqlCount() })
      .from(sessionBindings)
      .where(filter)
      .get();

    const rows = this.db
      .select(BINDING_COLUMNS)
      .from(sessionBindings)
      .where(filter)
      .orderBy(desc(sessionBindings.updatedAt), desc(sessionBindings.epoch))
      .limit(perPage)
      .offset((page - 1) * perPage)
      .all();

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
    // 引用者那条消息：同群同 app 内按 msg_idx 对上 quoted_msg_idx
    const quoted = alias(messages, "q");

    const rows = this.db
      .select({
        seq: messages.seq,
        appId: messages.appId,
        scope: messages.scope,
        peerId: messages.peerId,
        messageId: messages.messageId,
        senderId: messages.senderId,
        senderName: messages.senderName,
        content: messages.content,
        mentionsBot: messages.mentionsBot,
        mentions: messages.mentions,
        quotedContent: messages.quotedContent,
        msgIdx: messages.msgIdx,
        quotedMsgIdx: messages.quotedMsgIdx,
        attachments: messages.attachments,
        rawEventType: messages.rawEventType,
        timestamp: messages.timestamp,
        ts: messages.ts,
        quotedSenderId: quoted.senderId,
        quotedSenderName: quoted.senderName,
      })
      .from(messages)
      .leftJoin(
        quoted,
        and(
          eq(quoted.appId, messages.appId),
          eq(quoted.peerId, messages.peerId),
          eq(quoted.msgIdx, messages.quotedMsgIdx),
        ),
      )
      .where(and(...messageFilter(opts)))
      .orderBy(opts.order === "asc" ? asc(messages.seq) : desc(messages.seq))
      .limit(Math.max(1, Math.floor(opts.limit)))
      .all();

    return rows.map(toHistoryRow);
  }

  /** 同一组过滤条件下的条数，用来告诉模型"还有多少条没取" */
  count(opts: MessageFilter): number {
    const row = this.db
      .select({ n: sqlCount() })
      .from(messages)
      .where(and(...messageFilter(opts)))
      .get();
    return Number(row?.n ?? 0);
  }

  /** 整个 QQ 会话的规模（不带任何过滤），结果头部的"地图"用它 */
  stats(key: ChatKey): MessageStats {
    const row = this.db
      .select({
        n: sqlCount(),
        firstTs: min(messages.ts),
        lastTs: max(messages.ts),
      })
      .from(messages)
      .where(and(...messageFilter(key)))
      .get();

    return {
      total: Number(row?.n ?? 0),
      ...(row?.firstTs === null || row?.firstTs === undefined
        ? {}
        : { firstTs: Number(row.firstTs) }),
      ...(row?.lastTs === null || row?.lastTs === undefined
        ? {}
        : { lastTs: Number(row.lastTs) }),
    };
  }

  /** 该会话自某个时间点以来有多少条消息；excludeMentions 为真时只数非 @ 的 */
  countSince(key: ChatKey, sinceMs: number, excludeMentions = false): number {
    const conditions = [
      eq(messages.appId, key.appId),
      eq(messages.peerId, key.peerId),
      gt(messages.ts, sinceMs),
    ];
    if (excludeMentions) conditions.push(eq(messages.mentionsBot, false));

    const row = this.db
      .select({ n: sqlCount() })
      .from(messages)
      .where(and(...conditions))
      .get();
    return Number(row?.n ?? 0);
  }

  close(): void {
    try {
      this.db.$client.close();
    } catch {
      /* 已被关闭 */
    }
  }
}

/** LIKE 的通配符转义：`%`、`_`、`\` 都按字面量处理，模型给什么就找什么 */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** 会话绑定的四列：SELECT 与返回对象一一对应 */
const BINDING_COLUMNS = {
  epoch: sessionBindings.epoch,
  sessionId: sessionBindings.sessionId,
  createdAt: sessionBindings.createdAt,
  updatedAt: sessionBindings.updatedAt,
};

/** 绑定表的定位条件：一个 appId 下的一个 QQ 会话 */
function bindingKeyFilter(key: ChatKey): SQL {
  return and(
    eq(sessionBindings.appId, key.appId),
    eq(sessionBindings.scope, key.scope),
    eq(sessionBindings.peerId, key.peerId),
  ) as SQL;
}

/**
 * 过滤条件 → WHERE 片段。
 *
 * search / count / stats 共用同一套：要是走岔了，结果头部那句"还有 N 条"就是错的。
 */
function messageFilter(opts: MessageFilter): SQL[] {
  const conditions: SQL[] = [eq(messages.appId, opts.appId)];

  if (opts.scope) conditions.push(eq(messages.scope, opts.scope));
  if (opts.peerId) conditions.push(eq(messages.peerId, opts.peerId));
  if (opts.query) {
    // 附件是 JSON 列，整列 LIKE 就等于匹配文件名与 URL
    const like = likePattern(opts.query);
    conditions.push(sql`(
      ${messages.content} LIKE ${like} ESCAPE '\\'
      OR ${messages.quotedContent} LIKE ${like} ESCAPE '\\'
      OR ${messages.attachments} LIKE ${like} ESCAPE '\\'
    )`);
  }
  if (opts.sender) {
    // 昵称取不到时（单聊）只能靠 openid，所以两边都匹配
    const like = likePattern(opts.sender);
    conditions.push(sql`(
      ${messages.senderName} LIKE ${like} ESCAPE '\\'
      OR ${messages.senderId} LIKE ${like} ESCAPE '\\'
    )`);
  }
  if (opts.since !== undefined) conditions.push(gte(messages.ts, opts.since));
  if (opts.until !== undefined) conditions.push(lte(messages.ts, opts.until));
  if (opts.beforeSeq !== undefined) {
    conditions.push(lt(messages.seq, opts.beforeSeq));
  }
  if (opts.afterSeq !== undefined) {
    conditions.push(gt(messages.seq, opts.afterSeq));
  }
  if (opts.mentionsMe !== undefined) {
    conditions.push(eq(messages.mentionsBot, opts.mentionsMe));
  }

  return conditions;
}

function toSessionBinding(row: RawSessionBinding): SessionBinding {
  return {
    epoch: Number(row.epoch),
    sessionId: String(row.sessionId),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
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

/** 绑定表查出来的原始行 */
interface RawSessionBinding {
  epoch: number;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

/** search 查出来的原始行（列名已在 select 里映射成 camelCase） */
interface RawHistoryRow {
  seq: number;
  appId: string;
  scope: string;
  peerId: string;
  messageId: string;
  senderId: string;
  senderName: string | null;
  content: string;
  mentionsBot: boolean;
  mentions: string | null;
  quotedContent: string | null;
  msgIdx: string | null;
  quotedMsgIdx: string | null;
  attachments: string | null;
  rawEventType: string;
  timestamp: string;
  ts: number;
  quotedSenderId: string | null;
  quotedSenderName: string | null;
}

function toHistoryRow(row: RawHistoryRow): HistoryRow {
  return {
    seq: Number(row.seq),
    appId: String(row.appId),
    scope: String(row.scope) === "c2c" ? "c2c" : "group",
    peerId: String(row.peerId),
    messageId: String(row.messageId),
    senderId: String(row.senderId),
    senderName: optional(row.senderName),
    content: String(row.content),
    mentionsBot: row.mentionsBot,
    mentions: parseJson<MentionInfo[]>(row.mentions),
    quotedContent: optional(row.quotedContent),
    msgIdx: optional(row.msgIdx),
    quotedMsgIdx: optional(row.quotedMsgIdx),
    attachments: parseJson<AttachmentInfo[]>(row.attachments),
    rawEventType: String(row.rawEventType),
    timestamp: String(row.timestamp),
    ts: Number(row.ts),
    ...(optional(row.quotedSenderId) === undefined
      ? {}
      : { quotedSenderId: String(row.quotedSenderId) }),
    ...(optional(row.quotedSenderName) === undefined
      ? {}
      : { quotedSenderName: String(row.quotedSenderName) }),
  };
}

/** 可空列 → 可选字段：库里是 null，插件内部一律用 undefined */
function optional(value: string | null): string | undefined {
  return value === null ? undefined : String(value);
}
