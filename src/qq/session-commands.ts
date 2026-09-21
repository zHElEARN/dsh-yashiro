/**
 * 会话指令：`/current`、`/new`、`/switch <ID>`、`/list [页数]`、`/context`。
 *
 * 和 `/id` 一样由插件直接回复，不进 dsh、不消耗模型调用。解析与文案都是纯函数，
 * 落库/建会话这些副作用由 index.ts 处理。
 */

export interface SessionCommandUsage {
  kind: "usage";
  command: SessionCommandKind;
}

export type SessionCommandKind =
  | "current"
  | "new"
  | "switch"
  | "list"
  | "context";

export type SessionCommand =
  | { kind: "current" }
  | { kind: "new" }
  | { kind: "switch"; id: string }
  | { kind: "list"; page: number }
  | { kind: "context" }
  | SessionCommandUsage;

/** 会话 ID 在群里只显示前 8 位（sha256 全长 64 位，粘进 QQ 不现实） */
export const SESSION_ID_DISPLAY = 8;

/** 一页多少条 */
export const SESSIONS_PER_PAGE = 10;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_DISPLAY);
}

/**
 * 只有这些人才允许切换/新建会话。
 *
 * 群只要进了 allowedGroups，群里任何人都能驱动一个带 bash 权限的 agent ——
 * 会话指令再放开，等于任何人都能把当前会话换成自己的、或者刷出无数条会话。
 * 复用审批名单，不新增配置项。
 */
export function isSessionOperator(
  senderId: string,
  approvers: readonly string[],
): boolean {
  return approvers.includes(senderId);
}

/**
 * 解析一条会话指令；不是指令返回 undefined（调用方继续走 @ 流程）。
 *
 * 除 `/current` 和 `/new` 外，参数不合法一律回用法提示，不做模糊纠正 ——
 * 猜错群名或会话 ID 的代价是切到别的会话上。
 */
export function parseSessionCommand(
  content: string,
): SessionCommand | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const parts = trimmed.split(/\s+/);
  const name = parts[0];

  if (name === "/current") {
    return parts.length === 1
      ? { kind: "current" }
      : { kind: "usage", command: "current" };
  }
  if (name === "/new") {
    return parts.length === 1
      ? { kind: "new" }
      : { kind: "usage", command: "new" };
  }
  if (name === "/context") {
    return parts.length === 1
      ? { kind: "context" }
      : { kind: "usage", command: "context" };
  }
  if (name === "/switch") {
    return parts.length === 2 && parts[1] !== undefined
      ? { kind: "switch", id: parts[1] }
      : { kind: "usage", command: "switch" };
  }
  if (name === "/list") {
    if (parts.length === 1) return { kind: "list", page: 1 };
    const raw = parts[1];
    if (parts.length !== 2 || raw === undefined || !/^\d+$/.test(raw)) {
      return { kind: "usage", command: "list" };
    }
    const page = Number(raw);
    return page >= 1
      ? { kind: "list", page }
      : { kind: "usage", command: "list" };
  }
  return undefined;
}

/** 一行会话：`▶ 3f9a2b7c  2026-09-20 20:41  ← 当前`（updatedAt 的那一列） */
export interface SessionLine {
  id: string;
  /** 该 QQ 会话内的序号；/switch 拿它写回绑定表 */
  epoch: number;
  /** 最近使用时间，epoch 毫秒 */
  updatedAt: number;
  current: boolean;
}

export interface SessionCommandContext {
  /** 还没建过会话时为 undefined */
  current?: SessionLine;
  /** 该群/单聊的全部会话，按最近使用倒序 */
  sessions: readonly SessionLine[];
  /** 会话总数，用于算总页数 */
  total: number;
  /** 时间格式化，由调用方注入（默认用插件的 +08:00 口径） */
  formatTime(ts: number): string;
}

// ── 回复文案 ──

/** 没有会话时的统一提示；@ 和 /current 都复用它 */
export const NO_SESSION_TEXT =
  "这个群还没有会话。用 /new 建一个，之后 @ 我才会回应。";

export function buildUsageText(command: SessionCommandKind): string {
  switch (command) {
    case "current":
      return "/current 不接受参数。";
    case "new":
      return "/new 不接受参数。";
    case "switch":
      return "用法：/switch <会话 ID>。用 /list 看有哪些会话。";
    case "list":
      return "用法：/list [页数]，页数从 1 开始。";
    case "context":
      return "/context 不接受参数。";
  }
}

/** `/context` 要显示的东西，来自 agent 侧的会话日志折叠 */
export interface ContextLine {
  sessionId: string;
  createdAt?: number;
  model?: string;
  /** 最近一次请求的上下文占用（含缓存命中部分） */
  contextTokens?: number;
  contextWindow?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  lastActivityAt?: number;
  running: boolean;
  turns: number;
  steps: number;
  userMessages: number;
  toolCalls: number;
}

/**
 * `/context` 的文案。
 *
 * 上下文那一行刻意只显示「最近一次请求的提示词规模 / 窗口」，不显示累计值 ——
 * 累计值多轮之后会远大于窗口，看起来像超额了。
 */
export function buildContextText(
  info: ContextLine,
  formatTime: (ts: number) => string,
): string {
  const lines = ["会话上下文", `Session ID: ${shortSessionId(info.sessionId)}`];
  lines.push(
    info.createdAt === undefined
      ? "创建：未知"
      : `创建：${formatTime(info.createdAt)}`,
  );
  lines.push(
    info.model === undefined
      ? "模型：未知（还没跑过回合）"
      : `模型：${info.model}`,
  );

  if (info.contextTokens === undefined) {
    lines.push("上下文：还没跑过回合");
  } else {
    const used = formatTokens(info.contextTokens);
    lines.push(
      info.contextWindow === undefined
        ? `上下文：${used}`
        : `上下文：${used} / ${formatTokens(info.contextWindow)}（${percentOf(info.contextTokens, info.contextWindow)}）`,
    );
  }

  if (info.totalTokens !== undefined) {
    const cached = info.cacheReadTokens ?? 0;
    lines.push(
      `累计用量：${formatTokens(info.totalTokens)}（缓存命中 ${formatTokens(cached)}，${percentOf(cached, info.totalTokens)}）`,
    );
  }

  lines.push(
    `历史：${info.turns} 轮 · ${info.steps} 步 · ${info.userMessages} 条你的消息 · ${info.toolCalls} 次工具调用`,
  );
  lines.push(
    info.lastActivityAt === undefined
      ? "最后活动：暂无"
      : `最后活动：${formatTime(info.lastActivityAt)}${info.running ? "（正在跑回合）" : ""}`,
  );
  return lines.join("\n");
}

/** 1000 → `1k`，1500000 → `1.5m`；小于 1000 原样 */
export function formatTokens(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trimZero(value / 1000)}k`;
  return `${trimZero(value / 1_000_000)}m`;
}

function percentOf(part: number, whole: number): string {
  if (!Number.isFinite(whole) || whole <= 0) return "—";
  const ratio = part / whole;
  // 别把 99.6% 四舍五入成「100%」——那看起来像完全命中，是错的
  if (ratio < 1) return `${Math.min(99, Math.round(ratio * 100))}%`;
  return `${Math.round(ratio * 100)}%`;
}
function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function buildCurrentText(ctx: SessionCommandContext): string {
  const current = ctx.current;
  if (current === undefined) return NO_SESSION_TEXT;
  return [
    "当前会话",
    `Session ID: ${shortSessionId(current.id)}`,
    `创建：${ctx.formatTime(current.updatedAt)}`,
  ].join("\n");
}

export function buildListText(
  ctx: SessionCommandContext,
  page: number,
): string {
  if (ctx.total === 0) return NO_SESSION_TEXT;

  const pageCount = Math.max(1, Math.ceil(ctx.total / SESSIONS_PER_PAGE));
  if (page > pageCount) {
    return `第 ${page} 页不存在，一共 ${pageCount} 页（共 ${ctx.total} 条会话）。`;
  }
  return [
    `会话列表（第 ${page}/${pageCount} 页，共 ${ctx.total} 条，按最近使用排序）`,
    ...ctx.sessions.map((session) => formatLine(session, ctx)),
  ].join("\n");
}

export function buildSwitchOkText(
  session: SessionLine,
  formatTime: (ts: number) => string,
): string {
  return [
    `已切换：Session ID ${shortSessionId(session.id)}`,
    `创建：${formatTime(session.updatedAt)}`,
  ].join("\n");
}

/** 前缀匹配：唯一才切换，重名让用户多打几位 */
export function buildSwitchErrorText(
  id: string,
  matches: readonly SessionLine[],
): string {
  if (matches.length === 0) {
    return `没找到会话 ${id}。用 /list 看这条会话里有哪些。`;
  }
  const ids = matches.map((s) => shortSessionId(s.id)).join("、");
  return `${id} 匹配到 ${matches.length} 条会话（${ids}），多打几位再试。`;
}

/**
 * 按用户输入的片段找会话。
 *
 * 先按**列表里显示的那 8 位**匹配：用户在 /list 看到的就是这 8 位，所以粘贴过来必然命中。
 * 只有在这一层就不唯一时才退到全 ID 前缀匹配，让多打几位真的能消歧义 ——
 * 两条会话的前 8 位碰巧相同时，光看列表是分不出来的，只能靠多打几位。
 */
export function matchSession(
  raw: string,
  sessions: readonly SessionLine[],
): SessionLine[] {
  const input = raw.trim();
  if (input === "") return [];
  const byShortId = sessions.filter((s) => shortSessionId(s.id) === input);
  if (byShortId.length > 0) return byShortId;
  return sessions.filter((s) => s.id.startsWith(input));
}

export function buildNewSessionText(
  session: SessionLine,
  formatTime: (ts: number) => string,
): string {
  return [
    "已创建并切换：",
    `Session ID: ${shortSessionId(session.id)}`,
    `创建：${formatTime(session.updatedAt)}`,
  ].join("\n");
}

function formatLine(session: SessionLine, ctx: SessionCommandContext): string {
  const marker = session.current ? "▶" : " ";
  const suffix = session.current ? "  ← 当前" : "";
  return `${marker} ${shortSessionId(session.id)}  ${ctx.formatTime(session.updatedAt)}${suffix}`;
}
