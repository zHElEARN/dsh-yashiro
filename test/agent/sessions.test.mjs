import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { sessionIdOf, sessionKeyOf } from '../../dist/agent/sessions.js'

const APP = '1905501006'

describe('sessionKeyOf', () => {
  it('形如 yashiro:appId:scope:peerId', () => {
    assert.equal(sessionKeyOf(APP, 'group', 'G1'), `yashiro:${APP}:group:G1`)
    assert.equal(sessionKeyOf(APP, 'c2c', 'U1'), `yashiro:${APP}:c2c:U1`)
  })

  it('scope 参与区分：同一个 id 在群聊和单聊是两条会话', () => {
    assert.notEqual(sessionKeyOf(APP, 'group', 'X'), sessionKeyOf(APP, 'c2c', 'X'))
  })

  it('不同 appId 不串会话', () => {
    assert.notEqual(sessionKeyOf('a', 'group', 'G1'), sessionKeyOf('b', 'group', 'G1'))
  })
})

describe('sessionIdOf', () => {
  it('是确定性的 sha256（重启后能 resume 回同一条会话）', () => {
    const key = sessionKeyOf(APP, 'group', 'G1')
    assert.equal(sessionIdOf(key), sessionIdOf(key))
    assert.match(String(sessionIdOf(key)), /^[0-9a-f]{64}$/)
  })

  it('不同会话派生出不同 id', () => {
    assert.notEqual(sessionIdOf(sessionKeyOf(APP, 'group', 'G1')), sessionIdOf(sessionKeyOf(APP, 'group', 'G2')))
  })
})
