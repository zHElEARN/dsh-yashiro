/** 与平台无关的纯格式化：大小、截断、会话称谓 */
import type { Scope } from "./types.js";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 中文里指代这个会话的说法，配合「在…里」「到…里」用 */
export function whereLabel(scope: Scope): string {
  return scope === "group" ? "群" : "单聊";
}
