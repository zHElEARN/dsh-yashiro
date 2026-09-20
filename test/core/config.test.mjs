import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config } from '../../dist/core/config.js'

const minimal = { appId: 'x', appSecret: 'y' }

describe('Config', () => {
  it('busyDelivery 默认插队', () => {
    assert.equal(Config(minimal).busyDelivery, 'steer')
  })

  it('busyDelivery 可切成排队', () => {
    assert.equal(Config({ ...minimal, busyDelivery: 'queue' }).busyDelivery, 'queue')
  })

  it('busyDelivery 拒绝非法值', () => {
    assert.throws(() => Config({ ...minimal, busyDelivery: 'nope' }))
  })

  it('访问控制默认全禁（fail closed）', () => {
    const config = Config(minimal)
    assert.deepEqual(config.allowedGroups, [])
    assert.deepEqual(config.allowedUsers, [])
    assert.deepEqual(config.blockedSenders, [])
  })
})
