import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HistoryStore } from '../../dist/store.js'
import {
  createAgentTools,
  createHistoryTool,
  createSendFileTool,
  createSendTool,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
} from '../../dist/agent/tools.js'

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

/**
 * 填充数据：条数要顶过 HISTORY_MAX_LIMIT，否则「默认条数」和「上限夹取」这两个边界
 * 会因为库里一共就没几条而失去意义。时间一律早于上面那个窗口，窗口内的断言不受影响。
 */
const ANCHOR_TS = Date.parse('2026-09-20T18:00:00+08:00')
for (let i = 0; i < HISTORY_MAX_LIMIT; i += 1) {
  store.append({
    ...base,
    messageId: `f${i}`,
    content: `第 ${i} 条填充消息`,
    mentionsBot: false,
    timestamp: new Date(ANCHOR_TS - (i + 1) * 60_000).toISOString(),
  })
}

const config = { appId: APP }
const sent = []
const sentFiles = []
const gateway = {
  async send(scope, peerId, text) {
    sent.push({ scope, peerId, text })
    return 1
  },
  async sendFile(scope, peerId, localPath) {
    sentFiles.push({ scope, peerId, localPath })
    return { kind: 'file', fileName: 'report.pdf', fileSize: 2048 }
  },
}
const deps = { store, gateway, config, scope: 'group', peerId: 'G1' }

describe('qqbot_history', () => {
  it('不传 limit 时用默认条数', async () => {
    const result = await createHistoryTool(deps).execute({}, {})
    assert.equal(result.count, HISTORY_DEFAULT_LIMIT)
  })

  it('limit 被夹在上限内', async () => {
    const result = await createHistoryTool(deps).execute({ limit: 999 }, {})
    assert.equal(result.count, HISTORY_MAX_LIMIT)
  })

  it('结果按时间正序', async () => {
    const result = await createHistoryTool(deps).execute({ limit: 3 }, {})
    assert.deepEqual(
      result.messages.map((m) => m.sender),
      ['Zhe_Learn', 'Zhe_Learn', 'Zhe_Learn'],
    )
    // 取最近 3 条（h3、h4、超长那条），并按时间正序给出
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

describe('qqbot_send_file', () => {
  it('发出去并把出站记录也落库', async () => {
    sentFiles.length = 0
    const result = await createSendFileTool(deps).execute({ file_path: '/tmp/report.pdf' }, {})
    assert.deepEqual(result, { kind: 'file', fileName: 'report.pdf', fileSize: 2048 })
    assert.deepEqual(sentFiles, [{ scope: 'group', peerId: 'G1', localPath: '/tmp/report.pdf' }])

    const last = store.recent(APP, 'G1', 1).at(-1)
    assert.equal(last?.content, '[文件] report.pdf（2.0KB）')
    assert.equal(last?.rawEventType, 'OUTBOUND')
  })

  it('绝对路径原样透传', async () => {
    sentFiles.length = 0
    await createSendFileTool(deps).execute({ file_path: '/var/tmp/a.png' }, {})
    assert.equal(sentFiles[0].localPath, '/var/tmp/a.png')
  })

  it('相对路径按 agent 工作目录解析', async () => {
    sentFiles.length = 0
    const scoped = { ...deps, config: { ...config, cwd: '/tmp/ws' } }
    await createSendFileTool(scoped).execute({ file_path: 'out/chart.png' }, {})
    assert.equal(sentFiles[0].localPath, '/tmp/ws/out/chart.png')
  })

  it('空路径被拒', async () => {
    await assert.rejects(
      () => createSendFileTool(deps).execute({ file_path: '   ' }, {}),
      /file_path 不能为空/,
    )
  })

  it('发送失败时不落库', async () => {
    const before = store.recent(APP, 'G1', 1).at(-1)?.seq
    const failing = {
      ...deps,
      gateway: {
        ...gateway,
        async sendFile() {
          throw new Error('平台拒绝：没有文件消息权限')
        },
      },
    }
    await assert.rejects(
      () => createSendFileTool(failing).execute({ file_path: '/tmp/x.pdf' }, {}),
      /没有文件消息权限/,
    )
    assert.equal(store.recent(APP, 'G1', 1).at(-1)?.seq, before)
  })
})

describe('createAgentTools', () => {
  it('一次给出三个工具', () => {
    assert.deepEqual(
      createAgentTools(deps).map((tool) => tool.name),
      ['qqbot_history', 'qqbot_send', 'qqbot_send_file'],
    )
  })
})
