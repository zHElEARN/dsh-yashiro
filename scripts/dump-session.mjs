#!/usr/bin/env node
/**
 * 打印一条 dsh 会话的完整事件流（用于排查 agent 到底跑了什么）。
 *
 * 用法：
 *   node scripts/dump-session.mjs                 # 打印 cwd 对应的最新一条会话
 *   node scripts/dump-session.mjs <sessionId>     # 指定 sessionId
 *   node scripts/dump-session.mjs --all           # 只列出该 workspace 下的会话
 *
 * 每行带相对会话起点的耗时（+12.3s），相邻事件间隔超过 1.2s 会在行尾标出来，
 * 并在末尾打印整场统计与最慢的几步 —— 「为什么这么慢」看这个就够了。
 *
 * ⚠️ 坑：session.v3.jsonl.zstd 是**多个独立 zstd 帧拼接**的（每个 durable
 * append 批次一帧）。`zstdDecompressSync` 一次性解压只会拿到第一帧，看起来
 * 就像「只有一条 session 头事件」。必须按魔数切帧逐帧解。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 当前目录在 ~/.dsh/sessions 下的分桶名：路径里的 / 换成 -，两端补 -- */
function workspaceSlug(cwd) {
  return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

function decodeSessionLog(file) {
  const buf = readFileSync(file);
  const offsets = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i !== -1) {
    offsets.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  let text = "";
  for (let k = 0; k < offsets.length; k += 1) {
    const slice = buf.subarray(
      offsets[k],
      k + 1 < offsets.length ? offsets[k + 1] : buf.length,
    );
    try {
      text += zlib.zstdDecompressSync(slice).toString("utf8");
    } catch (err) {
      console.error(`  (第 ${k} 帧解压失败: ${err.message})`);
    }
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "(非 JSON 行)", raw: line.slice(0, 200) };
      }
    });
}

function summarize(ev) {
  const type = ev.type ?? "?";
  const data = ev.data ?? {};
  switch (type) {
    case "session":
      return `cwd=${ev.cwd} id=${String(ev.id).slice(0, 12)}…`;
    case "assistant/message": {
      const blocks = (data.message?.content ?? []).map((b) =>
        b.type === "text"
          ? `text(${b.text.length})`
          : b.type === "reasoning"
            ? "reasoning"
            : b.type,
      );
      return `step=${data.step} blocks=[${blocks.join(", ")}]`;
    }
    case "tool/call":
      return `${data.name} ${String(data.arguments).slice(0, 200)}`;
    case "tool/result": {
      const c = data.message?.content?.[0]?.content?.[0]?.text;
      return c ? String(c).slice(0, 200).replace(/\n/g, " ⏎ ") : "";
    }
    case "system/message":
      return String(data.message?.content?.[0]?.text ?? "")
        .slice(0, 120)
        .replace(/\n/g, " ⏎ ");
    case "user/message":
      return String(data.content?.[0]?.text ?? "")
        .slice(0, 160)
        .replace(/\n/g, " ⏎ ");
    case "request/header":
      return `model=${data.header?.config?.provider}/${data.header?.config?.model} effort=${data.header?.config?.reasoningEffort}`;
    default:
      return JSON.stringify(data).slice(0, 160);
  }
}

/** 会话起点（毫秒）：createdAt 可能是毫秒数，也可能是 ISO 串 */
function startedAt(events) {
  const created = events[0]?.createdAt;
  const parsed =
    typeof created === "number" ? created : Date.parse(created ?? "");
  if (Number.isFinite(parsed)) return parsed;
  return events.find((ev) => typeof ev.time === "number")?.time;
}

/** 单行预览：压掉换行、超长截断 */
function preview(text, limit = 160) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * assistant/message 里有两样别处看不到的内容：模型的 reasoning，以及它写给
 * 自己的普通输出（群友看不到，只有 qqbot_send 发出去的内容群友才看得到）。
 */
function blockPreviews(ev) {
  if (ev.type !== "assistant/message") return [];
  const lines = [];
  for (const block of ev.data?.message?.content ?? []) {
    if (block.type === "reasoning") lines.push(`🧠 ${preview(block.text)}`);
    else if (block.type === "text") lines.push(`💬 ${preview(block.text)}`);
  }
  return lines;
}

/**
 * 逐步耗时：模型时间 = step/start → assistant/message，工具时间 =
 * tool/call → tool/result。回合慢几乎总是因为模型步数多，而不是工具慢。
 */
function collectSteps(events) {
  const rows = [];
  let step = null;
  for (const ev of events) {
    if (ev.type === "step/start") {
      step = {
        step: ev.data?.step,
        start: ev.time,
        model: 0,
        tool: 0,
        pending: undefined,
        names: [],
      };
    }
    if (step === null || typeof ev.time !== "number") continue;
    if (ev.type === "assistant/message") step.model = ev.time - step.start;
    else if (ev.type === "tool/call") {
      step.pending = ev.time;
      step.names.push(ev.data?.name);
    } else if (ev.type === "tool/result" && step.pending !== undefined) {
      step.tool += ev.time - step.pending;
      step.pending = undefined;
    } else if (ev.type === "step/end") {
      step.total = ev.time - step.start;
      rows.push(step);
      step = null;
    }
  }
  return rows;
}

/** 整场统计：总耗时、步数、模型/工具累计、工具分布、最慢几步 */
function statsLines(events, t0) {
  const last = [...events].reverse().find((ev) => typeof ev.time === "number");
  if (t0 === undefined || last === undefined) return ["统计：该会话没有时间戳"];
  const rows = collectSteps(events);
  const sum = (key) => rows.reduce((acc, row) => acc + (row[key] ?? 0), 0);
  const byName = new Map();
  for (const row of rows)
    for (const name of row.names) byName.set(name, (byName.get(name) ?? 0) + 1);
  const models = rows.map((row) => row.model).sort((a, b) => a - b);
  const slowest = [...rows]
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
    .slice(0, 5);
  return [
    `统计：整场 ${((last.time - t0) / 1000).toFixed(1)}s｜步数 ${rows.length}｜` +
      `模型累计 ${(sum("model") / 1000).toFixed(1)}s｜工具累计 ${(sum("tool") / 1000).toFixed(1)}s`,
    models.length > 0
      ? `      单步模型：中位 ${(models[Math.floor(models.length / 2)] / 1000).toFixed(1)}s｜` +
        `最慢 ${(models.at(-1) / 1000).toFixed(1)}s`
      : "",
    `      工具：${byName.size > 0 ? [...byName].map(([n, c]) => `${n}×${c}`).join("、") : "无"}`,
    slowest.length > 0
      ? `      最慢几步：${slowest.map((row) => `step${row.step}=${((row.total ?? 0) / 1000).toFixed(1)}s`).join(" ")}`
      : "",
  ].filter(Boolean);
}

const args = process.argv.slice(2);
const cwd = process.cwd();
const bucket = join(homedir(), ".dsh", "sessions", workspaceSlug(cwd));

if (!existsSync(bucket)) {
  console.error(`找不到该 workspace 的会话目录：${bucket}`);
  process.exit(1);
}

const sessions = readdirSync(bucket, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

if (args.includes("--all")) {
  console.log(`${bucket}\n共 ${sessions.length} 条会话：`);
  for (const id of sessions) console.log(" ", id);
  process.exit(0);
}

const wanted = args[0];
const candidates = wanted ? [wanted] : sessions;
if (candidates.length === 0) {
  console.error("该 workspace 下还没有会话");
  process.exit(1);
}

/** 预览行的缩进：对齐到事件类型之后 */
const PREVIEW_INDENT = " ".repeat(24);

for (const id of candidates) {
  const dir = join(bucket, id);
  const file = readdirSync(dir).find((f) => f.includes("jsonl"));
  if (!file) continue;
  console.log(`\n===== ${id} (${file}) =====`);
  const events = decodeSessionLog(join(dir, file));
  const t0 = startedAt(events);
  let prev = t0;
  for (const ev of events) {
    const timed = typeof ev.time === "number";
    const gap = timed && prev !== undefined ? ev.time - prev : 0;
    if (timed) prev = ev.time;
    const rel =
      timed && t0 !== undefined
        ? `+${((ev.time - t0) / 1000).toFixed(1)}s`
        : "-";
    const mark =
      gap > 3000
        ? `  ⏱ +${(gap / 1000).toFixed(1)}s`
        : gap > 1200
          ? `  +${(gap / 1000).toFixed(1)}s`
          : "";
    console.log(
      `[${ev.seq ?? "-"}] ${rel.padStart(7)}  ${ev.type ?? "?"}  ${summarize(ev)}${mark}`,
    );
    for (const line of blockPreviews(ev))
      console.log(`${PREVIEW_INDENT}${line}`);
  }
  for (const line of statsLines(events, t0)) console.log(line);
  if (wanted) break;
}
