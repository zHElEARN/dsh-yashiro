import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatTokens } from '../../dist/qq/session-commands.js'
import { summarizeSessionLog } from '../../dist/agent/context-info.js'

/** 造一份最小可用的假日志 */
const log = (events, header = { createdAt: 1000, cwd: '/tmp/ws' }) => ({
  header,
  seq: events.length,
  snapshotEvents: () => events,
})

const usage = (input, cached, output) => ({
  inputTokens: input,
  cacheReadTokens: cached,
  outputTokens: output,
  totalTokens: input + cached + output,
})

describe('summarizeSessionLog', () => {
  it('空日志：什么都不猜，running 为假', () => {
    const s = summarizeSessionLog(log([]))
    assert.equal(s.model, undefined)
    assert.equal(s.contextTokens, undefined)
    assert.equal(s.totalTokens, undefined)
    assert.equal(s.lastActivityAt, undefined)
    assert.equal(s.running, false)
    assert.deepEqual(
      [s.turns, s.steps, s.userMessages, s.toolCalls],
      [0, 0, 0, 0],
    )
    assert.equal(s.createdAt, 1000)
  })

  it('上下文占用取最后一次请求，不是累计值', () => {
    const s = summarizeSessionLog(
      log([
        { type: 'assistant/message', time: 1, data: { usage: usage(100, 900, 50) } },
        { type: 'assistant/message', time: 2, data: { usage: usage(20, 980, 30) } },
      ]),
    )
    assert.equal(s.contextTokens, 1000, '最后一次请求的 input + cache')
    assert.equal(s.totalTokens, 1030, '累计值单独一个字段')
    assert.equal(s.cacheReadTokens, 980)
  })

  it('缺 totalTokens 时用最后一次的分解兜底', () => {
    const s = summarizeSessionLog(
      log([{ type: 'assistant/message', time: 1, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 } } }]),
    )
    assert.equal(s.totalTokens, 105)
  })

  it('模型与窗口来自 request/context，provider 拼在前面', () => {
    const s = summarizeSessionLog(
      log([{ type: 'request/context', time: 1, data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1000000 } }]),
    )
    assert.equal(s.model, 'deepseek-official/deepseek-flash')
    assert.equal(s.contextWindow, 1000000)
  })

  it('没有 provider 时只给模型名', () => {
    const s = summarizeSessionLog(log([{ type: 'request/context', time: 1, data: { model: 'm' } }]))
    assert.equal(s.model, 'm')
  })

  it('数轮次、步数、消息与工具调用', () => {
    const s = summarizeSessionLog(
      log([
        { type: 'turn/start', time: 1, data: { turn: 1 } },
        { type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
        { type: 'user/message', time: 3, data: {} },
        { type: 'tool/call', time: 4, data: {} },
        { type: 'tool/call', time: 5, data: {} },
        { type: 'step/end', time: 6, data: { turn: 1, step: 1 } },
        { type: 'turn/end', time: 7, data: { turn: 1 } },
      ]),
    )
    assert.deepEqual([s.turns, s.steps, s.userMessages, s.toolCalls], [1, 1, 1, 2])
    assert.equal(s.running, false)
  })

  it('回合开着没结束就是正在跑', () => {
    const s = summarizeSessionLog(
      log([
        { type: 'turn/start', time: 1, data: { turn: 1 } },
        { type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
        { type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
        { type: 'step/start', time: 4, data: { turn: 1, step: 2 } },
      ]),
    )
    assert.equal(s.running, true, '第二步开着没结束')
    assert.equal(s.lastActivityAt, 4)
  })

  it('最后活动取日志最后一条事件的时间', () => {
    const s = summarizeSessionLog(
      log([
        { type: 'turn/start', time: 10, data: { turn: 1 } },
        { type: 'turn/end', time: 99, data: { turn: 1 } },
      ]),
    )
    assert.equal(s.lastActivityAt, 99)
  })

  it('字段缺失或类型不对时不炸', () => {
    const s = summarizeSessionLog(
      log([
        { type: 'turn/start', time: 1 },
        { type: 'step/start', time: 2, data: { step: 1 } },
        { type: 'step/end', time: 3, data: { step: 1 } },
        // 下面这些字段都不可用：step 非数字、usage 字段类型不对、request/context 是 null
        { type: 'step/start', time: 4, data: { step: 'x' } },
        { type: 'assistant/message', time: 5, data: { usage: { inputTokens: 'oops' } } },
        { type: 'request/context', time: 6, data: null },
      ]),
    )
    assert.equal(s.contextTokens, 0)
    assert.equal(s.model, undefined)
    assert.equal(s.running, true, '最后一步开着（哪怕 step 字段读不出来）')
  })
})

describe('formatTokens', () => {
  it('小于 1000 原样，千与百万分别缩写成 k / m', () => {
    assert.equal(formatTokens(0), '0')
    assert.equal(formatTokens(999), '999')
    assert.equal(formatTokens(1000), '1k')
    assert.equal(formatTokens(1500), '1.5k')
    assert.equal(formatTokens(306122), '306.1k')
    assert.equal(formatTokens(1_000_000), '1m')
    assert.equal(formatTokens(1_250_000), '1.3m')
  })

  it('负数与小数不产生怪值', () => {
    assert.equal(formatTokens(-5), '0')
    assert.equal(formatTokens(1234.6), '1.2k')
  })
})
