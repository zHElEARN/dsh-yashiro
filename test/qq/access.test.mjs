import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildIdReply, decideAccess, isIdCommand } from '../../dist/qq/access.js'

const GROUP = 'A22459EFEB65CFF0405CB716510F7C57'
const USER = '04929CA16A512F57CFBCC3AD77A5D640'
const OTHER = 'BBB'

const empty = { allowedGroups: [], allowedUsers: [], blockedSenders: [] }
const open = { allowedGroups: [GROUP], allowedUsers: [USER], blockedSenders: [] }
const group = (peerId, senderId) => ({ scope: 'group', peerId, senderId })

describe('decideAccess：白名单 fail closed', () => {
  it('空白名单：群消息被拒且原因是 group-not-allowed', () => {
    const decision = decideAccess(group(GROUP, USER), empty)
    assert.equal(decision.action, 'deny-peer')
    assert.equal(decision.reason, 'group-not-allowed')
  })

  it('空白名单：单聊被拒', () => {
    assert.equal(decideAccess({ scope: 'c2c', peerId: USER, senderId: USER }, empty).action, 'deny-peer')
  })

  it('群在白名单 → 放行；不在 → 拒', () => {
    assert.equal(decideAccess(group(GROUP, USER), open).action, 'allow')
    assert.equal(decideAccess(group(OTHER, USER), open).action, 'deny-peer')
  })

  it('单聊在白名单 → 放行；不在 → 拒', () => {
    assert.equal(decideAccess({ scope: 'c2c', peerId: USER, senderId: USER }, open).action, 'allow')
    assert.equal(decideAccess({ scope: 'c2c', peerId: OTHER, senderId: USER }, open).action, 'deny-peer')
  })

  it("'*' 不是通配符", () => {
    const star = { allowedGroups: ['*'], allowedUsers: [], blockedSenders: [] }
    assert.equal(decideAccess(group(GROUP, USER), star).action, 'deny-peer')
  })
})

describe('decideAccess：黑名单只拦发送者', () => {
  const blocked = { allowedGroups: [GROUP], allowedUsers: [USER], blockedSenders: [OTHER] }

  it('黑名单命中 → deny-sender', () => {
    const decision = decideAccess(group(GROUP, OTHER), blocked)
    assert.equal(decision.action, 'deny-sender')
    assert.equal(decision.reason, 'sender-blocked')
  })

  it('黑名单不影响旁观者', () => {
    assert.equal(decideAccess(group(GROUP, USER), blocked).action, 'allow')
  })

  it('黑名单不按昵称匹配', () => {
    assert.equal(decideAccess(group(GROUP, 'Zhe_Learn'), blocked).action, 'allow')
  })
})

describe('isIdCommand', () => {
  it('@ + /id → 触发', () => {
    assert.equal(isIdCommand('/id', true), true)
    assert.equal(isIdCommand('  /id  ', true), true)
  })

  it('没 @ 就不触发', () => {
    assert.equal(isIdCommand('/id', false), false)
  })

  it('带参数 / 前缀 / 夹在正文里都不触发', () => {
    assert.equal(isIdCommand('/id foo', true), false)
    assert.equal(isIdCommand('/idabc', true), false)
    assert.equal(isIdCommand('帮我看看 /id 这个命令', true), false)
  })
})

describe('buildIdReply', () => {
  it('群回复报出 group_openid 与 sender openid', () => {
    const reply = buildIdReply({ scope: 'group', peerId: GROUP, senderId: USER, senderName: 'Zhe_Learn' })
    assert.ok(reply.includes(GROUP))
    assert.ok(reply.includes(USER))
  })

  it('单聊回复报出 user openid', () => {
    const reply = buildIdReply({ scope: 'c2c', peerId: USER, senderId: USER })
    assert.ok(reply.includes(USER))
    assert.ok(reply.includes('单聊'))
  })

  it('指路指向白名单，绝不把人引到黑名单', () => {
    const groupReply = buildIdReply({ scope: 'group', peerId: GROUP, senderId: USER })
    assert.ok(groupReply.includes('allowedGroups'), groupReply)
    assert.ok(!groupReply.includes('blockedSenders'), `回复不该让人填黑名单：${groupReply}`)

    const c2cReply = buildIdReply({ scope: 'c2c', peerId: USER, senderId: USER })
    assert.ok(c2cReply.includes('allowedUsers'), c2cReply)
    assert.ok(!c2cReply.includes('blockedSenders'), `回复不该让人填黑名单：${c2cReply}`)
  })

  it('单聊回复不教人填 allowedGroups', () => {
    const reply = buildIdReply({ scope: 'c2c', peerId: USER, senderId: USER })
    assert.ok(!reply.includes('allowedGroups'), reply)
  })
})
