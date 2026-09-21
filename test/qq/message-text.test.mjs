import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeInbound } from "../../dist/qq/gateway.js";
import { buildUserText } from "../../dist/qq/message-text.js";

/** 被引用消息带一张图、当前消息不带附件的形态 */
const quotedImage = {
  rawEventType: "GROUP_MESSAGE_CREATE",
  kind: "group",
  senderId: "U1",
  senderName: "Zhe_Learn",
  content: " <@BOT> 你看一下这张图看看是啥",
  messageId: "m-img",
  timestamp: "2026-09-20T19:22:59+08:00",
  groupOpenid: "G1",
  mentions: [{ is_you: true }],
  msgElements: [
    {
      content: "",
      message_type: 0,
      attachments: [
        {
          content_type: "image/jpeg",
          url: "https://multimedia.nt.qq.com.cn/download?fileid=abc",
          filename: "cat.jpg",
          width: 1206,
          height: 2622,
          size: 1363148,
        },
      ],
    },
  ],
};

describe("buildUserText：被引用消息的附件", () => {
  const msg = normalizeInbound("app", quotedImage);
  const text = buildUserText(msg);

  it("正文含被引用附件标题", () => {
    assert.ok(text.includes("被引用的那条消息带附件"), text);
  });

  it("正文含图片 URL", () => {
    assert.ok(
      text.includes("https://multimedia.nt.qq.com.cn/download?fileid=abc"),
    );
  });

  it("正文标明是图片并带尺寸", () => {
    assert.ok(text.includes("图片 cat.jpg 1206x2622"), text);
  });

  it("空正文有占位，不会送出空白消息", () => {
    const noText = normalizeInbound("app", {
      ...quotedImage,
      content: " <@BOT>  ",
    });
    assert.ok(buildUserText(noText).includes("没有文字内容"));
  });
});

describe("buildUserText：当前消息的附件", () => {
  const own = normalizeInbound("app", {
    ...quotedImage,
    content: " <@BOT> 看这个",
    msgElements: undefined,
    attachments: [
      {
        content_type: "image/png",
        url: "https://example.com/a.png",
        size: 2048,
      },
    ],
  });
  const text = buildUserText(own);

  it("正文含当前消息附件", () => {
    assert.ok(text.includes("这条消息带附件"), text);
  });

  it("小文件格式化", () => {
    assert.ok(text.includes("2.0KB"), text);
  });
});

describe("buildUserText：语音与多来源", () => {
  it("语音转写文本进入正文", () => {
    const voice = normalizeInbound("app", {
      ...quotedImage,
      msgElements: undefined,
      attachments: [
        {
          content_type: "voice",
          url: "https://example.com/v.silk",
          asr_refer_text: "今天天气不错",
        },
      ],
    });
    const text = buildUserText(voice);
    assert.ok(text.includes("平台转写文本: 今天天气不错"));
    assert.ok(text.includes("https://example.com/v.silk"));
  });

  it("两处附件同时出现", () => {
    const both = normalizeInbound("app", {
      ...quotedImage,
      attachments: [{ content_type: "file", url: "https://example.com/f.pdf" }],
    });
    const text = buildUserText(both);
    assert.ok(text.includes("被引用的那条消息带附件"));
    assert.ok(text.includes("这条消息带附件"));
  });

  it("纯文本正文不含附件标题", () => {
    const plain = normalizeInbound("app", {
      ...quotedImage,
      msgElements: undefined,
      attachments: undefined,
    });
    assert.ok(!buildUserText(plain).includes("带附件"));
  });
});
