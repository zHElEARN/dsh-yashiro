import { HistoryStore } from '../dist/store.js'
import { stripMentionMarkers, chunkText, normalizeInbound } from '../dist/gateway.js'
import { formatTime, platformNowIso } from '../dist/time.js'
import { buildIdReply, decideAccess, isIdCommand } from '../dist/access.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra) }
}

console.log('— stripMentionMarkers —')
check('剥掉 <@id>', stripMentionMarkers('<@423E7675108B24CED2325760E49EE511> hello') === 'hello')
check('剥掉 <@!id>', stripMentionMarkers('<@!ABC123> hi there') === 'hi there')
check('无标记原样', stripMentionMarkers('普通消息') === '普通消息')

console.log('— normalizeInbound（用实测到的真实 payload 形态）—')
const inbound = {
  rawEventType: 'GROUP_MESSAGE_CREATE', kind: 'group',
  senderId: '04929CA16A512F57CFBCC3AD77A5D640', senderName: 'Zhe_Learn',
  content: ' <@423E7675108B24CED2325760E49EE511> hello（回复信息同时带了@）',
  messageId: 'ROBOT1.0_xxx', timestamp: '2026-09-20T18:27:40+08:00',
  groupOpenid: 'A22459EFEB65CFF0405CB716510F7C57',
  mentions: [{ bot: true, id: '423E7675108B24CED2325760E49EE511', is_you: true, username: 'Yashiro' }],
  msgElements: [{ content: '我现在在让deepseek夺舍yashiro', message_type: 103 }],
}
const n = normalizeInbound('1905501006', inbound)
check('@ 被识别', n.mentionsBot === true)
check('正文剥掉 @', n.content === 'hello（回复信息同时带了@）', JSON.stringify(n.content))
check('引用内容带出', n.quotedContent === '我现在在让deepseek夺舍yashiro', JSON.stringify(n.quotedContent))
check('群 openid', n.peerId === 'A22459EFEB65CFF0405CB716510F7C57')

const noMention = normalizeInbound('1905501006', { ...inbound, content: 'hello（不带@的信息）', mentions: undefined, msgElements: undefined })
check('非 @ 不误判', noMention.mentionsBot === false)
check('非 @ 无引用', noMention.quotedContent === undefined)

const atEvent = normalizeInbound('1905501006', { ...inbound, rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: ' 123456', mentions: undefined, msgElements: undefined })
check('老事件名仍识别为 @', atEvent.mentionsBot === true)

const c2c = normalizeInbound('1905501006', { ...inbound, kind: 'c2c', groupOpenid: undefined, content: 'hi' })
check('单聊 peerId = senderId', c2c.scope === 'c2c' && c2c.peerId === inbound.senderId)
check('频道事件被忽略', normalizeInbound('1905501006', { ...inbound, kind: 'guild' }) === null)

console.log('— chunkText —')
check('短文本不切', chunkText('abc', 4500).length === 1)
const many = Array.from({ length: 400 }, (_, i) => `第${i}行内容`).join('\n')
const chunks = chunkText(many, 200)
check('长文本被切分', chunks.length > 1)
check('切分后无超长', chunks.every((c) => c.length <= 200), chunks.map(c => c.length).join(','))
check('切分后内容无损', chunks.join('\n').replace(/\s/g, '') === many.replace(/\s/g, ''))

console.log('— 访问控制 —')
{
  const GROUP = 'A22459EFEB65CFF0405CB716510F7C57'
  const USER = '04929CA16A512F57CFBCC3AD77A5D640'
  const OTHER = 'BBB'
  const empty = { allowedGroups: [], allowedUsers: [], blockedSenders: [] }
  const open = { allowedGroups: [GROUP], allowedUsers: [USER], blockedSenders: [] }
  const g = (peerId, senderId) => ({ scope: 'group', peerId, senderId })

  // 严格：空数组 = 全禁
  check('空白名单：群消息被拒', decideAccess(g(GROUP, USER), empty).action === 'deny-peer')
  check('空白名单：单聊被拒', decideAccess({ scope: 'c2c', peerId: USER, senderId: USER }, empty).action === 'deny-peer')
  check('空白名单拒绝原因是 group-not-allowed', decideAccess(g(GROUP, USER), empty).reason === 'group-not-allowed')

  // 放行
  check('群在白名单 → 放行', decideAccess(g(GROUP, USER), open).action === 'allow')
  check('群不在白名单 → 拒', decideAccess(g(OTHER, USER), open).action === 'deny-peer')
  check('单聊在白名单 → 放行', decideAccess({ scope: 'c2c', peerId: USER, senderId: USER }, open).action === 'allow')
  check('单聊不在白名单 → 拒', decideAccess({ scope: 'c2c', peerId: OTHER, senderId: USER }, open).action === 'deny-peer')

  // 不支持通配符：'*' 只是个普通字符串，不会匹配任何真实 id
  const star = { allowedGroups: ['*'], allowedUsers: [], blockedSenders: [] }
  check("'*' 不是通配符", decideAccess(g(GROUP, USER), star).action === 'deny-peer')

  // 黑名单：只拦发送者，会话本身仍然放行
  const blocked = { allowedGroups: [GROUP], allowedUsers: [USER], blockedSenders: [OTHER] }
  const d = decideAccess(g(GROUP, OTHER), blocked)
  check('黑名单命中 → deny-sender', d.action === 'deny-sender' && d.reason === 'sender-blocked')
  check('黑名单不影响旁观者', decideAccess(g(GROUP, USER), blocked).action === 'allow')
  check('黑名单不按昵称匹配', decideAccess(g(GROUP, 'Zhe_Learn'), blocked).action === 'allow')

  // /id 指令
  check('@ + /id → 触发', isIdCommand('/id', true))
  check('@ + 空白包裹的 /id → 触发', isIdCommand('  /id  ', true))
  check('没 @ 就不触发', !isIdCommand('/id', false))
  check('@ 但带参数不触发', !isIdCommand('/id foo', true))
  check('@ 但 /idabc 不触发', !isIdCommand('/idabc', true))
  check('@ 但普通消息不触发', !isIdCommand('帮我看看 /id 这个命令', true))

  const gr = buildIdReply({ scope: 'group', peerId: GROUP, senderId: USER, senderName: 'Zhe_Learn' })
  check('群 id 回复含 group_openid', gr.includes(GROUP))
  check('群 id 回复含 sender openid', gr.includes(USER))
  const cr = buildIdReply({ scope: 'c2c', peerId: USER, senderId: USER })
  check('单聊 id 回复含 user openid', cr.includes(USER) && cr.includes('单聊'))
}

console.log('— 时间格式化（回归：UTC 与 +08:00 必须显示成同一时刻）—')
{
  // 平台消息：+08:00
  const platform = formatTime(Date.parse('2026-09-20T18:46:10+08:00'))
  // 出站记录：曾用 new Date().toISOString() 写成 UTC，切字符串会早 8 小时
  const outbound = formatTime(Date.parse('2026-09-20T10:46:10.294Z'))
  check('平台格式 → 18:46:10', platform === '2026-09-20 18:46:10', platform)
  check('UTC 格式 → 同一时刻', outbound === platform, `${outbound} vs ${platform}`)
  check('platformNowIso 形如 +08:00', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(platformNowIso()), platformNowIso())
  check('platformNowIso 可被 Date.parse', Number.isFinite(Date.parse(platformNowIso())))
}

console.log('— HistoryStore —')
const dbPath = join(tmpdir(), `yashiro-selfcheck-${Date.now()}.db`)
const store = new HistoryStore(dbPath)
const base = { appId: '1905501006', scope: 'group', peerId: 'G1', senderId: 'U1', senderName: 'Zhe_Learn', rawEventType: 'GROUP_MESSAGE_CREATE' }
store.append({ ...base, messageId: 'm1', content: '今天天气不错', mentionsBot: false, timestamp: '2026-09-20T18:00:00+08:00' })
store.append({ ...base, messageId: 'm2', content: '推荐看看这本轻小说', mentionsBot: false, timestamp: '2026-09-20T18:01:00+08:00' })
store.append({ ...base, messageId: 'm3', content: '你帮我查查更新', mentionsBot: true, timestamp: '2026-09-20T18:02:00+08:00' })
store.append({ ...base, messageId: 'm1', content: '今天天气不错', mentionsBot: false, timestamp: '2026-09-20T18:00:00+08:00' }) // 重复
store.append({ ...base, scope: 'c2c', peerId: 'U9', messageId: 'm4', content: '私聊消息', mentionsBot: true, timestamp: '2026-09-20T18:03:00+08:00' })

check('重复 message_id 被忽略', store.search({ appId: '1905501006', peerId: 'G1', limit: 100 }).length === 3)
check('关键词检索', store.search({ appId: '1905501006', query: '轻小说', limit: 10 }).length === 1)
check('发送者过滤(3群+1单聊=4)', store.search({ appId: '1905501006', senderName: 'Zhe', limit: 10 }).length === 4)
check('会话隔离', store.search({ appId: '1905501006', peerId: 'U9', limit: 10 }).length === 1)
check('limit 生效', store.search({ appId: '1905501006', peerId: 'G1', limit: 2 }).length === 2)

const recent = store.recent('1905501006', 'G1', 10)
check('recent 按时间正序', recent.map(r => r.messageId).join(',') === 'm1,m2,m3', recent.map(r => r.messageId).join(','))
check('countSince 只数非 @', store.countSince('1905501006', 'G1', 0, true) === 2)
check('countSince 全部', store.countSince('1905501006', 'G1', 0, false) === 3)
check('countSince 时间窗', store.countSince('1905501006', 'G1', Date.parse('2026-09-20T18:01:30+08:00'), false) === 1)
check('lastTs', store.lastTs('1905501006', 'G1') === Date.parse('2026-09-20T18:02:00+08:00'))

store.append({ ...base, messageId: 'out1', senderId: 'SELF', senderName: '你（机器人）', content: '好的我去查', mentionsBot: false, rawEventType: 'OUTBOUND', timestamp: '2026-09-20T18:04:00+08:00' })
check('机器人自己的发言也入库', store.recent('1905501006', 'G1', 10).at(-1).content === '好的我去查')

store.close()
rmSync(dbPath, { force: true })
rmSync(`${dbPath}-wal`, { force: true })
rmSync(`${dbPath}-shm`, { force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
