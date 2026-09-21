/**
 * 把一个会话的事件日志折成「这个会话现在什么状况」。
 *
 * 只读冻结快照，不改日志、不调模型，所以是纯函数，可以用假事件直接测。
 *
 * 一处容易搞错的口径：`usage.totalTokens` 是**跨请求累计值**（等于它自己那一次请求的
 * input + cache + output），不是上下文占用。当前上下文有多大，要看**最后一次请求**的
 * `inputTokens + cacheReadTokens` —— 见 ContextSummary.contextTokens 的注释。
 */

/** session 日志里我们读得到的部分（@deepseek-ai/dsh-session 的最小面） */
export interface SessionLogLike {
  readonly header?: { readonly createdAt?: number; readonly cwd?: string };
  snapshotEvents(): readonly SessionEventLike[];
  readonly seq: number;
}

export interface SessionEventLike {
  type: string;
  /** Unix epoch 毫秒 */
  time: number;
  data?: unknown;
}

export interface ContextSummary {
  /** 会话创建时间，缺了显示成未知 */
  createdAt?: number;
  /** 还没有任何请求时是 undefined */
  model?: string;
  /** 模型给的上下文窗口大小 */
  contextWindow?: number;
  /**
   * 最近一次请求送进去的提示词规模（已含缓存命中的那部分）。
   * 这才是「上下文现在有多大」——不要用下面的 totalTokens。
   */
  contextTokens?: number;
  /** 整个会话累计消耗的 token（跨请求累计） */
  totalTokens?: number;
  cacheReadTokens: number;
  /** 日志里最后一条事件的时间；空日志时 undefined */
  lastActivityAt?: number;
  /** 正在跑回合（有 turn/step 开了还没结束） */
  running: boolean;
  turns: number;
  steps: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
}

interface RequestContextLike {
  provider?: string;
  model?: string;
  contextWindow?: number;
}

export function summarizeSessionLog(log: SessionLogLike): ContextSummary {
  const events = log.snapshotEvents();

  const summary: ContextSummary = {
    ...(typeof log.header?.createdAt === "number"
      ? { createdAt: log.header.createdAt }
      : {}),
    cacheReadTokens: 0,
    running: false,
    turns: 0,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
  };

  // 用「是否处于打开的回合/步内」判断，而不是比较 turn/step 计数：计数依赖事件里的
  // 字段能读出来，字段缺失时判断就失真了
  let turnOpen = false;
  let stepOpen = false;

  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        summary.turns += 1;
        turnOpen = true;
        break;
      case "turn/end":
        turnOpen = false;
        break;
      case "step/start":
        summary.steps += 1;
        stepOpen = true;
        break;
      case "step/end":
        stepOpen = false;
        break;
      case "user/message":
        summary.userMessages += 1;
        break;
      case "tool/call":
        summary.toolCalls += 1;
        break;
      case "request/context": {
        const context = event.data as RequestContextLike | undefined;
        const model = contextModel(context);
        if (model !== undefined) summary.model = model;
        if (typeof context?.contextWindow === "number")
          summary.contextWindow = context.contextWindow;
        break;
      }
      case "assistant/message": {
        summary.assistantMessages += 1;
        const usage = (event.data as { usage?: UsageLike } | undefined)?.usage;
        if (usage !== undefined) applyUsage(summary, usage);
        break;
      }
      default:
        break;
    }
  }

  if (events.length > 0) {
    summary.lastActivityAt = events[events.length - 1]?.time;
  }
  summary.running = turnOpen || stepOpen;
  return summary;
}

/** 每次出现 usage 都覆盖：只有最后一次代表当前上下文占用的口径 */
function applyUsage(summary: ContextSummary, usage: UsageLike): void {
  const input = numberOr0(usage.inputTokens);
  const cached = numberOr0(usage.cacheReadTokens);
  const output = numberOr0(usage.outputTokens);
  summary.contextTokens = input + cached;
  if (typeof usage.totalTokens === "number")
    summary.totalTokens = usage.totalTokens;
  summary.cacheReadTokens = cached;
  // 累计值缺失时用最后一次的分解兜底，免得那一行空着
  if (summary.totalTokens === undefined)
    summary.totalTokens = input + cached + output;
}

function contextModel(
  context: RequestContextLike | null | undefined,
): string | undefined {
  // 日志是从 JSON 反序列化来的，data 可能是 null，不能只挡 undefined
  if (context === null || context === undefined) return undefined;
  const provider = context.provider?.trim();
  const model = context.model?.trim();
  if (model === undefined || model === "") return undefined;
  return provider !== undefined && provider !== ""
    ? `${provider}/${model}`
    : model;
}

function numberOr0(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
