import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chunkText, normalizeInbound, stripMentionMarkers } from '../../dist/qq/gateway.js'

/** 实测到的真实 payload 形态（全量模式下 @ 消息也叫 GROUP_MESSAGE_CREATE） */
const inbound = {
  rawEventType: 'GROUP_MESSAGE_CREATE',
  kind: 'group',
  senderId: '04929CA16A512F57CFBCC3AD77A5D640',
  senderName: 'Zhe_Learn',
  content: ' <@423E7675108B24CED2325760E49EE511> hello（回复信息同时带了@）',
  messageId: 'ROBOT1.0_xxx',
  timestamp: '2026-09-20T18:27:40+08:00',
  groupOpenid: 'A22459EFEB65CFF0405CB716510F7C57',
  mentions: [{ bot: true, id: '423E7675108B24CED2325760E49EE511', is_you: true, username: 'Yashiro' }],
  msgElements: [{ content: '我现在在让deepseek夺舍yashiro', message_type: 103 }],
}

describe('stripMentionMarkers', () => {
  it('剥掉 <@id>', () => {
    assert.equal(stripMentionMarkers('<@423E7675108B24CED2325760E49EE511> hello'), 'hello')
  })

  it('剥掉 <@!id>', () => {
    assert.equal(stripMentionMarkers('<@!ABC123> hi there'), 'hi there')
  })

  it('无标记原样', () => {
    assert.equal(stripMentionMarkers('普通消息'), '普通消息')
  })
})

describe('normalizeInbound', () => {
  it('@ 被识别', () => {
    assert.equal(normalizeInbound('1905501006', inbound).mentionsBot, true)
  })

  it('正文剥掉 @', () => {
    assert.equal(normalizeInbound('1905501006', inbound).content, 'hello（回复信息同时带了@）')
  })

  it('引用内容带出', () => {
    assert.equal(normalizeInbound('1905501006', inbound).quotedContent, '我现在在让deepseek夺舍yashiro')
  })

  it('群 openid', () => {
    assert.equal(normalizeInbound('1905501006', inbound).peerId, 'A22459EFEB65CFF0405CB716510F7C57')
  })

  it('非 @ 不误判', () => {
    const msg = normalizeInbound('1905501006', {
      ...inbound,
      content: 'hello（不带@的信息）',
      mentions: undefined,
      msgElements: undefined,
    })
    assert.equal(msg.mentionsBot, false)
  })

  it('非 @ 无引用', () => {
    const msg = normalizeInbound('1905501006', {
      ...inbound,
      content: 'hello（不带@的信息）',
      mentions: undefined,
      msgElements: undefined,
    })
    assert.equal(msg.quotedContent, undefined)
  })

  it('老事件名仍识别为 @', () => {
    const msg = normalizeInbound('1905501006', {
      ...inbound,
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      content: ' 123456',
      mentions: undefined,
      msgElements: undefined,
    })
    assert.equal(msg.mentionsBot, true)
  })

  it('单聊 peerId = senderId', () => {
    const msg = normalizeInbound('1905501006', { ...inbound, kind: 'c2c', groupOpenid: undefined, content: 'hi' })
    assert.equal(msg.scope, 'c2c')
    assert.equal(msg.peerId, inbound.senderId)
  })

  it('频道事件被忽略', () => {
    assert.equal(normalizeInbound('1905501006', { ...inbound, kind: 'guild' }), null)
  })
})

describe('chunkText', () => {
  const many = Array.from({ length: 400 }, (_, i) => `第${i}行内容`).join('\n')

  it('短文本不切', () => {
    assert.equal(chunkText('abc', 4500).length, 1)
  })

  it('长文本被切分', () => {
    assert.ok(chunkText(many, 200).length > 1)
  })

  it('切分后无超长', () => {
    assert.ok(chunkText(many, 200).every((c) => c.length <= 200))
  })

  it('切分后内容无损', () => {
    const joined = chunkText(many, 200).join('\n').replace(/\s/g, '')
    assert.equal(joined, many.replace(/\s/g, ''))
  })
})

describe('附件传递', () => {
  /**
   * 引用一张纯图片再 @ 机器人：被引用消息没有文字，附件只挂在 msgElements[0] 上。
   * 这条路径必须一直有覆盖 —— 附件送不到 agent 面前时，它只会看到一条空消息。
   */
  const quotedImage = {
    rawEventType: 'GROUP_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'U1',
    senderName: 'Zhe_Learn',
    content: ' <@BOT> 你看一下这张图看看是啥',
    messageId: 'm-img',
    timestamp: '2026-09-20T19:22:59+08:00',
    groupOpenid: 'G1',
    mentions: [{ is_you: true }],
    msgElements: [
      {
        content: '',
        message_type: 0,
        attachments: [
          {
            content_type: 'image/jpeg',
            url: 'https://multimedia.nt.qq.com.cn/download?fileid=abc',
            filename: 'cat.jpg',
            width: 1206,
            height: 2622,
            size: 1363148,
          },
        ],
      },
    ],
  }

  it('引用图片 → 附件被抓到且标记来源为 quoted', () => {
    const msg = normalizeInbound('app', quotedImage)
    assert.equal(msg.attachments?.length, 1)
    assert.equal(msg.attachments?.[0]?.from, 'quoted')
    assert.ok(String(msg.attachments?.[0]?.url).includes('multimedia.nt.qq.com.cn'))
    assert.equal(msg.attachments?.[0]?.width, 1206)
    assert.equal(msg.attachments?.[0]?.height, 2622)
  })

  it('直接附图 → from=current', () => {
    const own = normalizeInbound('app', {
      ...quotedImage,
      content: ' <@BOT> 看这个',
      msgElements: undefined,
      attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png', size: 2048 }],
    })
    assert.equal(own.attachments?.[0]?.from, 'current')
  })

  it('语音转写被抓到', () => {
    const voice = normalizeInbound('app', {
      ...quotedImage,
      msgElements: undefined,
      attachments: [{ content_type: 'voice', url: 'https://example.com/v.silk', asr_refer_text: '今天天气不错' }],
    })
    assert.equal(voice.attachments?.[0]?.asrText, '今天天气不错')
  })

  it('两处附件都在', () => {
    const both = normalizeInbound('app', {
      ...quotedImage,
      attachments: [{ content_type: 'file', url: 'https://example.com/f.pdf' }],
    })
    assert.equal(both.attachments?.length, 2)
  })

  it('只发图不打字时正文被剥空', () => {
    const noText = normalizeInbound('app', { ...quotedImage, content: ' <@BOT>  ' })
    assert.equal(noText.content, '')
  })

  it('纯文本无附件', () => {
    const plain = normalizeInbound('app', { ...quotedImage, msgElements: undefined, attachments: undefined })
    assert.equal(plain.attachments, undefined)
  })
})
