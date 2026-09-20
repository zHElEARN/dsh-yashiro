#!/usr/bin/env node
/**
 * 打印一条 dsh 会话的完整事件流（用于排查 agent 到底跑了什么）。
 *
 * 用法：
 *   node scripts/dump-session.mjs                 # 打印 cwd 对应的最新一条会话
 *   node scripts/dump-session.mjs <sessionId>     # 指定 sessionId
 *   node scripts/dump-session.mjs --all           # 只列出该 workspace 下的会话
 *
 * ⚠️ 坑：session.v3.jsonl.zstd 是**多个独立 zstd 帧拼接**的（每个 durable
 * append 批次一帧）。`zstdDecompressSync` 一次性解压只会拿到第一帧，看起来
 * 就像「只有一条 session 头事件」。必须按魔数切帧逐帧解。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 当前目录在 ~/.dsh/sessions 下的分桶名：路径里的 / 换成 -，两端补 -- */
function workspaceSlug(cwd) {
  return `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`
}

function decodeSessionLog(file) {
  const buf = readFileSync(file)
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i)
    i += 4
  }
  let text = ''
  for (let k = 0; k < offsets.length; k += 1) {
    const slice = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length)
    try {
      text += zlib.zstdDecompressSync(slice).toString('utf8')
    } catch (err) {
      console.error(`  (第 ${k} 帧解压失败: ${err.message})`)
    }
  }
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { type: '(非 JSON 行)', raw: line.slice(0, 200) }
      }
    })
}

function summarize(ev) {
  const type = ev.type ?? '?'
  const data = ev.data ?? {}
  switch (type) {
    case 'session':
      return `cwd=${ev.cwd} id=${String(ev.id).slice(0, 12)}…`
    case 'assistant/message': {
      const blocks = (data.message?.content ?? []).map((b) =>
        b.type === 'text' ? `text(${b.text.length})` : b.type === 'reasoning' ? 'reasoning' : b.type,
      )
      return `step=${data.step} blocks=[${blocks.join(', ')}]`
    }
    case 'tool/call':
      return `${data.name} ${String(data.arguments).slice(0, 200)}`
    case 'tool/result': {
      const c = data.message?.content?.[0]?.content?.[0]?.text
      return c ? String(c).slice(0, 200).replace(/\n/g, ' ⏎ ') : ''
    }
    case 'system/message':
      return String(data.message?.content?.[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' ⏎ ')
    case 'user/message':
      return String(data.content?.[0]?.text ?? '').slice(0, 160).replace(/\n/g, ' ⏎ ')
    case 'request/header':
      return `model=${data.header?.config?.provider}/${data.header?.config?.model} effort=${data.header?.config?.reasoningEffort}`
    default:
      return JSON.stringify(data).slice(0, 160)
  }
}

const args = process.argv.slice(2)
const cwd = process.cwd()
const bucket = join(homedir(), '.dsh', 'sessions', workspaceSlug(cwd))

if (!existsSync(bucket)) {
  console.error(`找不到该 workspace 的会话目录：${bucket}`)
  process.exit(1)
}

const sessions = readdirSync(bucket, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

if (args.includes('--all')) {
  console.log(`${bucket}\n共 ${sessions.length} 条会话：`)
  for (const id of sessions) console.log(' ', id)
  process.exit(0)
}

const wanted = args[0]
const candidates = wanted ? [wanted] : sessions
if (candidates.length === 0) {
  console.error('该 workspace 下还没有会话')
  process.exit(1)
}

for (const id of candidates) {
  const dir = join(bucket, id)
  const file = readdirSync(dir).find((f) => f.includes('jsonl'))
  if (!file) continue
  console.log(`\n===== ${id} (${file}) =====`)
  for (const ev of decodeSessionLog(join(dir, file))) {
    console.log(`[${ev.seq ?? '-'}] ${ev.type ?? '?'}  ${summarize(ev)}`)
  }
  if (wanted) break
}
