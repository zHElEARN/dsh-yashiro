/**
 * 回合异常播报：哪些 `turn/end` 收尾值得在 QQ 里说一声，以及怎么说。
 *
 * 只认两种：
 * - `error`：结构化失败，agent 这一轮没跑完，群里可能半句话都没有
 * - `max-tokens`：某个 step 撞到输出上限（即使有插件把回合续了下去），群里那份回复
 *   很可能"话说了一半"
 *
 * 其余一律不报，各有理由：
 * - `aborted`：有人 `/stop` 或父级取消 —— `/stop` 自己会回执，再报一条就重复了
 * - `blocked`：goal 的续跑轮在进 step 前被拒，reason 里只有 kind、没有任何可展示的细节
 * - `interrupted`：不是实时失败，而是"崩溃后补写的收尾"，它出现的时机是这条会话下次
 *   被 resume（群里下次 @ 或 /switch）时，播报出来会被误读成"刚发的这条出错了"
 * - `completed`：正常结束
 *
 * 文案只带 code + 一句人话：模型原始报错（可能含路径、内部细节）不进群。
 */

/** `turn/end` 事件里我们用到的最小面，结构化对齐 dsh-session 的 TurnEndReason */
export interface TurnEndReasonLike {
  kind?: unknown;
  /** kind === "error" 时是结构化失败（LlmFailure） */
  error?: unknown;
}

export function buildTurnNoticeText(
  reason: TurnEndReasonLike | undefined,
): string | undefined {
  const kind = reason?.kind;
  if (kind === "max-tokens") {
    return "⚠️ 回复被输出上限截断了（max-tokens），可能不完整。";
  }
  if (kind !== "error") return undefined;
  return `⚠️ 这个回合失败了（${failureCode(reason?.error)}），没有跑完。`;
}

/** 认不出 code 时给 UNKNOWN，不编造、也不把原始错误塞进文案 */
function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "UNKNOWN";
}
