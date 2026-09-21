/**
 * 历史里展示的时间一律用 epoch 毫秒格式化，不要切 timestamp 字符串：
 * 平台消息带 +08:00、出站记录带 Z，同一个时刻切出来会差 8 小时。
 */

export const DISPLAY_TIME_ZONE = "Asia/Shanghai";

/** 展示时区相对 UTC 的偏移，跟 `DISPLAY_TIME_ZONE` 绑死 */
export const DISPLAY_UTC_OFFSET = "+08:00";

/** 借 sv-SE 的 `YYYY-MM-DD HH:mm:ss` 格式做确定性输出，避免受运行环境 locale 影响 */
const TIME_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** zh-CN 的短星期（周一）—— 模型从日期推星期几并不可靠，直接告诉它 */
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "short",
});

export function formatTime(ts: number): string {
  return TIME_FORMATTER.format(new Date(ts));
}

/**
 * `09-21 15:03`。直接切 `formatTime` 的定长输出，不再养一个 formatter ——
 * 少一个 formatter 就少一处可能跟主格式走岔的地方。
 */
export function formatShortTime(ts: number): string {
  return formatTime(ts).slice(5, 16);
}

export function formatWeekday(ts: number): string {
  return WEEKDAY_FORMATTER.format(new Date(ts));
}

/** 当前时间，写成与平台一致的 `+08:00` 形式 */
export function platformNowIso(): string {
  return `${TIME_FORMATTER.format(new Date()).replace(" ", "T")}${DISPLAY_UTC_OFFSET}`;
}
