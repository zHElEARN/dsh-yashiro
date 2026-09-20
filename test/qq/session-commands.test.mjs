import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildContextText,
  buildCurrentText,
  buildListText,
  buildNewSessionText,
  buildSwitchErrorText,
  buildSwitchOkText,
  buildUsageText,
  isSessionOperator,
  matchSession,
  NO_SESSION_TEXT,
  parseSessionCommand,
  SESSIONS_PER_PAGE,
  shortSessionId,
} from '../../dist/qq/session-commands.js'

/** 固定时间格式，避免用例依赖本地时区 */
const formatTime = (ts) => `T${ts}`

const line = (id, updatedAt, current = false) => ({ id, epoch: 1, updatedAt, current })

describe('parseSessionCommand', () => {
  it('四条指令的基本形态', () => {
    assert.deepEqual(parseSessionCommand('/current'), { kind: 'current' })
    assert.deepEqual(parseSessionCommand('/new'), { kind: 'new' })
    assert.deepEqual(parseSessionCommand('/switch abc123'), { kind: 'switch', id: 'abc123' })
    assert.deepEqual(parseSessionCommand('/list'), { kind: 'list', page: 1 })
    assert.deepEqual(parseSessionCommand('/list 3'), { kind: 'list', page: 3 })
    assert.deepEqual(parseSessionCommand('/context'), { kind: 'context' })
  })

  it('前后空白与重复空格都能容忍', () => {
    assert.deepEqual(parseSessionCommand('  /new  '), { kind: 'new' })
    assert.deepEqual(parseSessionCommand('/switch   abc123'), { kind: 'switch', id: 'abc123' })
  })

  it('不是指令返回 undefined，@ 正文照常走', () => {
    assert.equal(parseSessionCommand('你好'), undefined)
    assert.equal(parseSessionCommand('帮我看看 /new 这个命令'), undefined)
    assert.equal(parseSessionCommand('/newxxx'), undefined)
    assert.equal(parseSessionCommand('/id'), undefined, '/id 有自己的处理分支')
  })

  it('参数不合法回用法，不猜', () => {
    assert.deepEqual(parseSessionCommand('/current 1'), { kind: 'usage', command: 'current' })
    assert.deepEqual(parseSessionCommand('/new 1'), { kind: 'usage', command: 'new' })
    assert.deepEqual(parseSessionCommand('/switch'), { kind: 'usage', command: 'switch' })
    assert.deepEqual(parseSessionCommand('/switch a b'), { kind: 'usage', command: 'switch' })
    assert.deepEqual(parseSessionCommand('/list abc'), { kind: 'usage', command: 'list' })
    assert.deepEqual(parseSessionCommand('/list 0'), { kind: 'usage', command: 'list' })
    assert.deepEqual(parseSessionCommand('/list -1'), { kind: 'usage', command: 'list' })
    assert.deepEqual(parseSessionCommand('/context 1'), { kind: 'usage', command: 'context' })
  })
})

describe('isSessionOperator', () => {
  it('只有名单内的人能操作会话', () => {
    assert.equal(isSessionOperator('U1', ['U1', 'U2']), true)
    assert.equal(isSessionOperator('U3', ['U1', 'U2']), false)
  })

  it('名单为空时谁都不能用', () => {
    assert.equal(isSessionOperator('U1', []), false)
  })
})

describe('会话指令文案', () => {
  it('没有会话时统一提示 /new', () => {
    const ctx = { sessions: [], total: 0, formatTime }
    assert.equal(buildCurrentText(ctx), NO_SESSION_TEXT)
    assert.equal(buildListText(ctx, 1), NO_SESSION_TEXT)
  })

  it('/current 报短 ID 和创建时间', () => {
    const ctx = { current: line('a'.repeat(64), 100), sessions: [], total: 1, formatTime }
    assert.equal(buildCurrentText(ctx), '当前会话\nSession ID: aaaaaaaa\n创建：T100')
  })

  it('/list 标出当前、带分页头', () => {
    const ctx = {
      current: line('a'.repeat(64), 300, true),
      sessions: [line('a'.repeat(64), 300, true), line('b'.repeat(64), 200)],
      total: 2,
      formatTime,
    }
    assert.equal(
      buildListText(ctx, 1),
      ['会话列表（第 1/1 页，共 2 条，按最近使用排序）', '▶ aaaaaaaa  T300  ← 当前', '  bbbbbbbb  T200'].join('\n'),
    )
  })

  it('/list 页码越界单独报，不静默', () => {
    const ctx = { sessions: [], total: 3, formatTime }
    assert.equal(buildListText(ctx, 2), '第 2 页不存在，一共 1 页（共 3 条会话）。')
  })

  it('/list 每页 10 条', () => {
    assert.equal(SESSIONS_PER_PAGE, 10)
    const sessions = Array.from({ length: SESSIONS_PER_PAGE }, (_, i) => line(`${i}`.padStart(8, '0'), i))
    const ctx = { sessions, total: 25, formatTime }
    assert.match(buildListText(ctx, 1), /第 1\/3 页，共 25 条/)
  })

  it('/switch 前缀找不到与重名分别有话说', () => {
    assert.match(buildSwitchErrorText('zzz', []), /没找到会话 zzz/)
    const two = [line('a'.repeat(64), 1), line(`aa${'b'.repeat(62)}`, 2)]
    assert.match(buildSwitchErrorText('a', two), /匹配到 2 条会话/)
  })
  it('/switch 成功与 /new 都报短 ID', () => {
    const target = line('c'.repeat(64), 500)
    assert.equal(buildSwitchOkText(target, formatTime), '已切换：Session ID cccccccc\n创建：T500')
    assert.equal(buildNewSessionText(target, formatTime), '已创建并切换：\nSession ID: cccccccc\n创建：T500')
  })

  it('用法提示逐条齐全', () => {
    for (const kind of ['current', 'new', 'switch', 'list', 'context']) {
      assert.ok(buildUsageText(kind).length > 0)
    }
    assert.match(buildUsageText('switch'), /\/switch <会话 ID>/)
    assert.match(buildUsageText('list'), /\/list \[页数\]/)
  })

  it('短 ID 取前 8 位', () => {
    assert.equal(shortSessionId('0123456789abcdef'), '01234567')
  })
})

describe('matchSession', () => {
  const A = 'aaaaaaaa1111'
  const B = 'bbbbbbbb2222'
  const A2 = 'aaaaaaaa9999'

  it('粘贴列表里显示的 8 位就能命中', () => {
    assert.deepEqual(matchSession('aaaaaaaa', [line(A, 1), line(B, 2)]).map((s) => s.id), [A])
  })

  it('完整 ID 也认', () => {
    assert.deepEqual(matchSession(A, [line(A, 1), line(B, 2)]).map((s) => s.id), [A])
  })

  it('两条会话前 8 位相同时，多打几位能消歧义', () => {
    const sessions = [line(A, 1), line(A2, 2), line(B, 3)]
    assert.equal(matchSession('aaaaaaaa', sessions).length, 2, '只看 8 位应判为歧义')
    assert.deepEqual(matchSession('aaaaaaaa9', sessions).map((s) => s.id), [A2], '多打一位应唯一')
    assert.deepEqual(matchSession(A, sessions).map((s) => s.id), [A])
  })

  it('找不到或空输入都返回空，不猜一个出来', () => {
    assert.deepEqual(matchSession('zzzz', [line(A, 1)]), [])
    assert.deepEqual(matchSession('', [line(A, 1)]), [])
    assert.deepEqual(matchSession('  ', [line(A, 1)]), [])
  })
})

describe('buildContextText', () => {
  const full = {
    sessionId: '1806fe0ded4b3fa1f43f22fbd456fe915dd1e13f90da1624ac3058a45ea0af56',
    createdAt: 100,
    model: 'deepseek-official/deepseek-flash',
    contextTokens: 306122,
    contextWindow: 1000000,
    totalTokens: 307200,
    cacheReadTokens: 305920,
    lastActivityAt: 200,
    running: false,
    turns: 11,
    steps: 299,
    userMessages: 14,
    toolCalls: 375,
  }

  it('跑过的会话：七行，短 ID、占用比例、累计、历史、最后活动', () => {
    assert.equal(
      buildContextText(full, formatTime),
      [
        '会话上下文',
        'Session ID: 1806fe0d',
        '创建：T100',
        '模型：deepseek-official/deepseek-flash',
        '上下文：306.1k / 1m（31%）',
        '累计用量：307.2k（缓存命中 305.9k，99%）',
        '历史：11 轮 · 299 步 · 14 条你的消息 · 375 次工具调用',
        '最后活动：T200',
      ].join('\n'),
    )
  })

  it('正在跑回合时在最后活动那行标注', () => {
    assert.match(buildContextText({ ...full, running: true }, formatTime), /最后活动：T200（正在跑回合）/)
  })

  it('/new 之后没跑过：模型与占用都显示未知，不编数字', () => {
    const fresh = {
      sessionId: 'a'.repeat(64),
      createdAt: 300,
      running: false,
      turns: 0,
      steps: 0,
      userMessages: 0,
      toolCalls: 0,
    }
    assert.equal(
      buildContextText(fresh, formatTime),
      [
        '会话上下文',
        'Session ID: aaaaaaaa',
        '创建：T300',
        '模型：未知（还没跑过回合）',
        '上下文：还没跑过回合',
        '历史：0 轮 · 0 步 · 0 条你的消息 · 0 次工具调用',
        '最后活动：暂无',
      ].join('\n'),
    )
  })

  it('缓存命中不足 100% 时不许四舍五入成 100%', () => {
    const text = buildContextText({ ...full, totalTokens: 307200, cacheReadTokens: 305920 }, formatTime)
    assert.match(text, /99%/, text)
    assert.ok(!text.includes('100%'), text)
  })

  it('窗口未知时只报占用，不报比例', () => {
    const text = buildContextText({ ...full, contextWindow: undefined }, formatTime)
    assert.match(text, /上下文：306\.1k\n/)
  })

  it('创建时间缺失时报未知', () => {
    const text = buildContextText({ ...full, createdAt: undefined }, formatTime)
    assert.match(text, /创建：未知/)
  })
})
