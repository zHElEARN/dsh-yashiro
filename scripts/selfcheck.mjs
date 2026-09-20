import { HistoryStore } from '../dist/store.js'
import { stripMentionMarkers, chunkText, normalizeInbound } from '../dist/gateway.js'
import { formatTime, platformNowIso } from '../dist/time.js'
import { buildIdReply, decideAccess, isIdCommand } from '../dist/access.js'
import { buildUserText } from '../dist/message-text.js'
import { Config } from '../dist/config.js'
import {
  buildApprovalKeyboard,
  buildApprovalText,
  commandOf,
  decodeApprovalButton,
  encodeApprovalButton,
} from '../dist/approval.js'
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

console.log('— 附件传递（回归：引用图片时附件必须送到 agent 面前）—')
{
  // 场景：引用一张纯图片再 @ 机器人。被引用消息没有文字，附件挂在 msgElements[0] 上。
  const quotedImage = {
    rawEventType: 'GROUP_MESSAGE_CREATE', kind: 'group',
    senderId: 'U1', senderName: 'Zhe_Learn',
    content: ' <@BOT> 你看一下这张图看看是啥',
    messageId: 'm-img', timestamp: '2026-09-20T19:22:59+08:00',
    groupOpenid: 'G1',
    mentions: [{ is_you: true }],
    msgElements: [{
      content: '',
      message_type: 0,
      attachments: [{
        content_type: 'image/jpeg', url: 'https://multimedia.nt.qq.com.cn/download?fileid=abc',
        filename: 'cat.jpg', width: 1206, height: 2622, size: 1363148,
      }],
    }],
  }
  const msg = normalizeInbound('app', quotedImage)
  check('引用图片 → 附件被抓到', msg.attachments?.length === 1, JSON.stringify(msg.attachments))
  check('附件标记来源为 quoted', msg.attachments?.[0]?.from === 'quoted')
  check('附件带 URL', String(msg.attachments?.[0]?.url).includes('multimedia.nt.qq.com.cn'))
  check('附件带尺寸', msg.attachments?.[0]?.width === 1206 && msg.attachments?.[0]?.height === 2622)

  const text = buildUserText(msg)
  check('正文含被引用附件标题', text.includes('被引用的那条消息带附件'), text)
  check('正文含图片 URL', text.includes('https://multimedia.nt.qq.com.cn/download?fileid=abc'))
  check('正文标明是图片', text.includes('图片 cat.jpg 1206x2622'))
  // 场景：只发图 + @，一个字都不打（剥掉 @ 标记后正文为空）
  const noText = normalizeInbound('app', { ...quotedImage, content: ' <@BOT>  ' })
  check('剥掉 @ 后正文为空', noText.content === '', JSON.stringify(noText.content))
  check('空正文有占位', buildUserText(noText).includes('没有文字内容'))

  // 场景：直接把图跟 @ 一起发
  const ownImage = { ...quotedImage, content: ' <@BOT> 看这个', msgElements: undefined,
    attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png', size: 2048 }] }
  const own = normalizeInbound('app', ownImage)
  check('直接附图 → from=current', own.attachments?.[0]?.from === 'current')
  check('正文含当前消息附件', buildUserText(own).includes('这条消息带附件'))
  check('小文件格式化', buildUserText(own).includes('2.0KB'))

  // 场景：语音带平台转写
  const voice = { ...quotedImage, msgElements: undefined,
    attachments: [{ content_type: 'voice', url: 'https://example.com/v.silk', asr_refer_text: '今天天气不错' }] }
  const v = normalizeInbound('app', voice)
  check('语音转写被抓到', v.attachments?.[0]?.asrText === '今天天气不错')
  check('正文含转写文本', buildUserText(v).includes('平台转写文本: 今天天气不错'))
  check('正文含语音 URL', buildUserText(v).includes('https://example.com/v.silk'))

  // 场景：两处附件同时存在
  const both = normalizeInbound('app', { ...quotedImage, attachments: [{ content_type: 'file', url: 'https://example.com/f.pdf' }] })
  check('两处附件都在', both.attachments?.length === 2)
  const bt = buildUserText(both)
  check('正文同时出现两种来源', bt.includes('被引用的那条消息带附件') && bt.includes('这条消息带附件'))

  // 场景：纯文本不该受影响
  const plain = normalizeInbound('app', { ...quotedImage, msgElements: undefined, attachments: undefined })
  check('纯文本无附件', plain.attachments === undefined)
  check('纯文本正文不含附件标题', !buildUserText(plain).includes('带附件'))
}

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

console.log('— Config —')
check('busyDelivery 默认插队', Config({ appId: 'x', appSecret: 'y' }).busyDelivery === 'steer')
check('busyDelivery 可切成排队', Config({ appId: 'x', appSecret: 'y', busyDelivery: 'queue' }).busyDelivery === 'queue')
check('busyDelivery 拒绝非法值', (() => {
  try { Config({ appId: 'x', appSecret: 'y', busyDelivery: 'nope' }); return false } catch { return true }
})())

console.log('— 审批通道（纯函数部分）—')
{
  const request = {
    agent: {
      id: 's1',
      session: {
        events: [
          { type: 'tool/call', data: { callId: 'c1', arguments: JSON.stringify({ command: 'rm -rf /tmp/x', description: '清理' }) } },
        ],
      },
    },
    toolName: 'bash',
    callId: 'c1',
    reason: '需要写工作区外的文件',
  }

  check('button_data 往返', decodeApprovalButton(encodeApprovalButton('allow'))?.d === 'allow')
  check('别的通道的 button_data 不认', decodeApprovalButton('{"t":"question","q":"x","i":0}') === undefined)
  check('非 JSON 不认', decodeApprovalButton('nope') === undefined)

  const buttons = buildApprovalKeyboard([]).content.rows[0].buttons
  check('两个按钮', buttons.length === 2)
  check('回调按钮 + 只能点一次', buttons.every((b) => b.action.type === 1 && b.action.click_limit === 1))
  check('同一 group_id（点一个另一个变灰）', buttons[0].group_id === buttons[1].group_id)
  check('approvers 为空 = 所有人可点', buttons[0].action.permission.type === 2)
  const restricted = buildApprovalKeyboard(['04929CA16A512F57CFBCC3AD77A5D640']).content.rows[0].buttons[0]
  check('指定审批人：type=0 + specify_user_ids',
    restricted.action.permission.type === 0 &&
    restricted.action.permission.specify_user_ids?.[0] === '04929CA16A512F57CFBCC3AD77A5D640')

  check('命令回显（按 callId 倒查 tool/call）', commandOf(request) === 'rm -rf /tmp/x')
  check('callId 对不上返回 undefined', commandOf({ ...request, callId: 'nope' }) === undefined)
  const card = buildApprovalText(request, commandOf(request), 300_000)
  check('卡片含工具名 / 命令 / 理由 / 超时',
    card.includes('bash') && card.includes('rm -rf /tmp/x') &&
    card.includes('需要写工作区外的文件') && card.includes('5 分钟'))

  // rc.2 的 Session 没有 events 数组，只有 eventAt(seq) + seq。
  // 之前照抄官方契约读 session.events.length，线上就是这么炸的 —— 这条是回归。
  const toolCall = request.agent.session.events[0]
  const rc2 = { ...request, agent: { id: 's1', session: { seq: 1, eventAt: (i) => (i === 0 ? toolCall : undefined) } } }
  const naked = { ...request, agent: { id: 's1', session: {} } }
  check('命令回显（rc.2：eventAt + seq）', commandOf(rc2) === 'rm -rf /tmp/x')
  check('两种形状都读不到 → undefined 且不抛错', commandOf(naked) === undefined)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
