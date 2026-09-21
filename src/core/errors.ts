/** 把 catch 到的东西格式化成一行可读的错误描述（插件里所有日志都用它） */
export function describeError(err: unknown): string {
  if (err instanceof Error)
    return `${err.name}: ${err.message}\n${err.stack ?? ""}`;
  return String(err);
}
