/**
 * 会话指令：`/current`、`/new`、`/switch <ID>`、`/list [页数]`、`/context`。
 *
 * 和 `/id` 一样由插件直接回复，不进 dsh、不消耗模型调用。解析与文案都是纯函数，
 * 落库/建会话这些副作用由 index.ts 处理。
 */
import type { ContextSummary } from "../agent/context-info.js";
import { formatTime } from "../core/time.js";

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
  | { kind: "usage"; command: SessionCommandKind }
  /** `/` 开头但不认识；command 是它原本的样子，用于回提示 */
  | { kind: "unknown"; command: string };

/** 会话 ID 在群里只显示前 8 位（sha256 全长 64 位，粘进 QQ 不现实） */
export const SESSION_ID_DISPLAY = 8;

export const SESSIONS_PER_PAGE = 10;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_DISPLAY);
}

/** 这三条都不接受参数 */
const NO_ARG_COMMANDS: Record<string, "current" | "new" | "context"> = {
  "/current": "current",
  "/new": "new",
  "/context": "context",
};

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

/** `/id` 绕过访问控制、有自己的处理分支，所以这里不接管它，只借这个常量做排除 */
export const ID_COMMAND = "/id";

/**
 * 去掉正文里的 @ 词，只留指令本身。
 *
 * 正文里的 @ 已经换成 `@昵称`（映射不到时是 `<@OPENID>`），指令前面常带一个 @机器人，
 * 所以解析前先把这些词摘掉：`@Yashiro /id` 与 `/id` 等价。
 */
export function stripMentionWords(content: string): string {
  return content
    .trim()
    .split(/\s+/)
    .filter((word) => !word.startsWith("@") && !word.startsWith("<@"))
    .join(" ");
}

/**
 * 解析一条会话指令；不是指令返回 undefined（调用方继续走 @ 流程）。
 *
 * `/` 开头但认不出来的一律当未知指令 —— 不再丢给模型，免得斜杠开头的闲聊被当成任务。
 * 参数不合法则回用法提示，不做模糊纠正 —— 猜错会话 ID 的代价是切到别的会话上。
 */
export function parseSessionCommand(
  content: string,
): SessionCommand | undefined {
  const [name, argument, ...extra] = stripMentionWords(content).split(/\s+/);
  if (name === undefined || !name.startsWith("/")) return undefined;
  if (name === ID_COMMAND) return undefined;
  const noArg = argument === undefined && extra.length === 0;
  const oneArg = argument !== undefined && extra.length === 0;

  const kind = NO_ARG_COMMANDS[name];
  if (kind !== undefined) {
    return noArg ? { kind } : { kind: "usage", command: kind };
  }

  if (name === "/switch") {
    return oneArg
      ? { kind: "switch", id: argument }
      : { kind: "usage", command: "switch" };
  }

  if (name === "/list") {
    if (noArg) return { kind: "list", page: 1 };
    if (!oneArg || !/^\d+$/.test(argument) || Number(argument) < 1) {
      return { kind: "usage", command: "list" };
    }
    return { kind: "list", page: Number(argument) };
  }

  return { kind: "unknown", command: name };
}

export function buildUnknownCommandText(command: string): string {
  return `未知指令 ${command}。可用：/current /new /switch /list /context /id。`;
}

/** 一行会话：`▶ 3f9a2b7c  2026-09-20 20:41  ← 当前` */
export interface SessionLine {
  id: string;
  /** 该 QQ 会话内的序号；/switch 拿它写回绑定表 */
  epoch: number;
  /** 最近使用时间，epoch 毫秒 */
  updatedAt: number;
  current: boolean;
}

/** `/list` 的输入 */
export interface SessionListContext {
  /** 还没建过会话时为 undefined */
  current?: SessionLine;
  /** 这一页要显示的会话，按最近使用倒序 */
  sessions: readonly SessionLine[];
  /** 会话总数，用于算总页数 */
  total: number;
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

/**
 * 一条会话的展示：标题 + Session ID + 时间。
 *
 * label 由调用方定：`/new` 报的是创建时间，`/current` 和 `/switch` 报的是最近使用时间
 * （绑定表的 updated_at 每次投递都会刷新）。
 */
export function buildSessionText(
  title: string,
  session: SessionLine,
  label: string,
): string {
  return [
    title,
    `Session ID: ${shortSessionId(session.id)}`,
    `${label}：${formatTime(session.updatedAt)}`,
  ].join("\n");
}

export function buildListText(ctx: SessionListContext, page: number): string {
  if (ctx.total === 0) return NO_SESSION_TEXT;

  const pageCount = Math.max(1, Math.ceil(ctx.total / SESSIONS_PER_PAGE));
  if (page > pageCount) {
    return `第 ${page} 页不存在，一共 ${pageCount} 页（共 ${ctx.total} 条会话）。`;
  }
  return [
    `会话列表（第 ${page}/${pageCount} 页，共 ${ctx.total} 条，按最近使用排序）`,
    ...ctx.sessions.map(formatLine),
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

/** `/context` 要显示的东西，来自 agent 侧的会话日志折叠 */
export type ContextLine = ContextSummary & { sessionId: string };

/**
 * `/context` 的文案。
 *
 * 上下文那一行刻意只显示「最近一次请求的提示词规模 / 窗口」，不显示累计值 ——
 * 累计值多轮之后会远大于窗口，看起来像超额了。
 */
export function buildContextText(info: ContextLine): string {
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

function formatLine(session: SessionLine): string {
  const marker = session.current ? "▶" : " ";
  const suffix = session.current ? "  ← 当前" : "";
  return `${marker} ${shortSessionId(session.id)}  ${formatTime(session.updatedAt)}${suffix}`;
}
