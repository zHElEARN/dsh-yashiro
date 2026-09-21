/** 把 catch 到的东西（Error / 字符串 / 任意值）格式化成一行可读描述，插件里所有日志都用它 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}\n${err.stack ?? ""}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
