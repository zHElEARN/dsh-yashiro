/**
 * 时间格式化。
 *
 * QQ 平台给的时间戳都带 +08:00，机器人自己写入的出站记录也统一按这个时区，
 * 保证 agent 在历史里看到的时间是一致的。
 *
 * ⚠️ 一律从 epoch 毫秒格式化，**不要**去切原始 timestamp 字符串 ——
 * 那正是之前的 bug：平台消息是 `...+08:00`，我们自己写的出站记录一度是
 * `new Date().toISOString()`（UTC），切前 19 位会让机器人的发言早 8 小时。
 */

/** 展示用时区 */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai'

/** `sv-SE` locale 的日期格式正好是 `YYYY-MM-DD HH:mm:ss`，用它做确定性格式化 */
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

/** 把 epoch 毫秒格式化成 `YYYY-MM-DD HH:mm:ss` */
export function formatTime(ts: number): string {
  return TIME_FORMATTER.format(new Date(ts))
}

/** 当前时间，写成与平台一致的 `+08:00` 形式 */
export function platformNowIso(): string {
  return `${TIME_FORMATTER.format(new Date()).replace(' ', 'T')}+08:00`
}
