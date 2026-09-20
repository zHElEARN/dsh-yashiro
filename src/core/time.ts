/**
 * 历史里展示的时间一律用 epoch 毫秒格式化，不要切 timestamp 字符串：
 * 平台消息带 +08:00、出站记录带 Z，同一个时刻切出来会差 8 小时。
 */

export const DISPLAY_TIME_ZONE = 'Asia/Shanghai'

/** 借 sv-SE 的 `YYYY-MM-DD HH:mm:ss` 格式做确定性输出，避免受运行环境 locale 影响 */
const TIME_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatTime(ts: number): string {
  return TIME_FORMATTER.format(new Date(ts))
}

/** 当前时间，写成与平台一致的 `+08:00` 形式 */
export function platformNowIso(): string {
  return `${TIME_FORMATTER.format(new Date()).replace(' ', 'T')}+08:00`
}
