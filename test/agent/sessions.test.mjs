import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { sessionIdOf, sessionKeyOf } from '../../dist/agent/sessions.js'

const APP = '1905501006'

describe('sessionKeyOf', () => {
  it('形如 yashiro:appId:scope:peerId:epoch', () => {
    assert.equal(sessionKeyOf(APP, 'group', 'G1', 1), `yashiro:${APP}:group:G1:1`)
    assert.equal(sessionKeyOf(APP, 'c2c', 'U1', 2), `yashiro:${APP}:c2c:U1:2`)
  })

  it('scope 参与区分：同一个 id 在群聊和单聊是两条会话', () => {
    assert.notEqual(sessionKeyOf(APP, 'group', 'X', 1), sessionKeyOf(APP, 'c2c', 'X', 1))
  })

  it('不同 appId 不串会话', () => {
    assert.notEqual(sessionKeyOf('a', 'group', 'G1', 1), sessionKeyOf('b', 'group', 'G1', 1))
  })

  it('epoch 参与区分：同一个群里多条会话互不相同', () => {
    assert.notEqual(sessionKeyOf(APP, 'group', 'G1', 1), sessionKeyOf(APP, 'group', 'G1', 2))
  })
})

describe('sessionIdOf', () => {
  it('是确定性的 sha256（重启后能 resume 回同一条会话）', () => {
    const key = sessionKeyOf(APP, 'group', 'G1', 1)
    assert.equal(sessionIdOf(key), sessionIdOf(key))
    assert.match(String(sessionIdOf(key)), /^[0-9a-f]{64}$/)
  })

  it('不同会话派生出不同 id', () => {
    assert.notEqual(
      sessionIdOf(sessionKeyOf(APP, 'group', 'G1', 1)),
      sessionIdOf(sessionKeyOf(APP, 'group', 'G2', 1)),
    )
  })

  it('同群不同 epoch 派生出不同 id', () => {
    assert.notEqual(
      sessionIdOf(sessionKeyOf(APP, 'group', 'G1', 1)),
      sessionIdOf(sessionKeyOf(APP, 'group', 'G1', 2)),
    )
  })
})
