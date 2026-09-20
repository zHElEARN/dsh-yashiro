import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HistoryStore } from '../../dist/store.js'
import { createAgentTools, createHistoryTool, createSendTool } from '../../dist/agent/tools.js'

const dbPath = join(tmpdir(), `yashiro-tools-${process.pid}-${Date.now()}.db`)
const store = new HistoryStore(dbPath)

after(() => {
  store.close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
})

const APP = '1905501006'
const base = {
  appId: APP,
  scope: 'group',
  peerId: 'G1',
  senderId: 'U1',
  senderName: 'Zhe_Learn',
  rawEventType: 'GROUP_MESSAGE_CREATE',
}
for (let i = 0; i < 5; i += 1) {
  store.append({
    ...base,
    messageId: `h${i}`,
    content: `第 ${i} 条消息`,
    mentionsBot: false,
    timestamp: `2026-09-20T18:0${i}:00+08:00`,
  })
}
store.append({ ...base, messageId: 'long', content: 'x'.repeat(900), mentionsBot: false, timestamp: '2026-09-20T18:09:00+08:00' })

const config = { appId: APP, historyDefaultLimit: 3, historyMaxLimit: 4 }
const sent = []
const gateway = {
  async send(scope, peerId, text) {
    sent.push({ scope, peerId, text })
    return 1
  },
}
const deps = { store, gateway, config, scope: 'group', peerId: 'G1' }

describe('qqbot_history', () => {
  it('不传 limit 时用默认条数', async () => {
    const result = await createHistoryTool(deps).execute({}, {})
    assert.equal(result.count, 3)
  })

  it('limit 被夹在上限内', async () => {
    const result = await createHistoryTool(deps).execute({ limit: 999 }, {})
    assert.equal(result.count, 4)
  })

  it('结果按时间正序', async () => {
    const result = await createHistoryTool(deps).execute({}, {})
    assert.deepEqual(
      result.messages.map((m) => m.sender),
      ['Zhe_Learn', 'Zhe_Learn', 'Zhe_Learn'],
    )
    // 默认取最近 3 条（h3、h4、超长那条），并按时间正序给出
    assert.equal(result.messages[0].content, '第 3 条消息')
    assert.equal(result.messages[1].content, '第 4 条消息')
  })

  it('单条消息过长会截断', async () => {
    const result = await createHistoryTool(deps).execute({ query: 'xxx' }, {})
    assert.ok(result.messages[0].content.endsWith('…（已截断）'))
    assert.ok(result.messages[0].content.length < 900)
  })

  it('sender_name 作为展示名', async () => {
    const result = await createHistoryTool(deps).execute({}, {})
    assert.equal(result.messages[0].sender, 'Zhe_Learn')
  })
})

describe('qqbot_send', () => {
  it('发出去并返回条数', async () => {
    sent.length = 0
    const result = await createSendTool(deps).execute({ text: '收到' }, {})
    assert.equal(result.sent, 1)
    assert.deepEqual(sent, [{ scope: 'group', peerId: 'G1', text: '收到' }])
  })

  it('自己发的内容也落库，标成 SELF / OUTBOUND', async () => {
    await createSendTool(deps).execute({ text: '我查完了' }, {})
    const last = store.recent(APP, 'G1', 10).at(-1)
    assert.equal(last?.content, '我查完了')
    assert.equal(last?.senderId, 'SELF')
    assert.equal(last?.rawEventType, 'OUTBOUND')
  })
})

describe('createAgentTools', () => {
  it('一次给出两个工具', () => {
    assert.deepEqual(
      createAgentTools(deps).map((tool) => tool.name),
      ['qqbot_history', 'qqbot_send'],
    )
  })
})
