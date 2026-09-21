import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeInbound } from "../../dist/qq/gateway.js";
import { buildUserText } from "../../dist/qq/message-text.js";
import { quotedImage } from "../helpers.mjs";

describe("buildUserText：被引用消息的附件", () => {
  const msg = normalizeInbound("app", quotedImage);
  const text = buildUserText(msg);

  it("正文含被引用附件的标题、URL、类型与尺寸", () => {
    assert.ok(text.includes("被引用的那条消息带附件"), text);
    assert.ok(
      text.includes("https://multimedia.nt.qq.com.cn/download?fileid=abc"),
      text,
    );
    assert.ok(text.includes("图片 cat.jpg 1206x2622"), text);
  });

  it("空正文有占位，不会送出空白消息", () => {
    const noText = normalizeInbound("app", {
      ...quotedImage,
      content: "",
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

describe("buildUserText：单聊", () => {
  it("拿不到昵称时用「对方」，不把 openid 当人名", () => {
    const msg = normalizeInbound("app", {
      ...quotedImage,
      kind: "c2c",
      groupOpenid: undefined,
      senderName: undefined,
      content: "在吗",
    });
    const text = buildUserText(msg);
    assert.match(text, /^对方 在单聊里 @ 了你：/);
    assert.ok(!text.includes(msg.senderId), text);
  });
});

describe("buildUserText：唤醒锚点", () => {
  const msg = normalizeInbound("app", quotedImage);

  it("有锚点就一定写出来，哪怕这期间没人说话", () => {
    const text = buildUserText(msg, {
      lastDeliveredSeq: 124,
      newSinceLastWake: 0,
    });
    assert.ok(
      text.includes("（你上次被唤醒时投递到 #124；此后群里没有新消息。）"),
      text,
    );
  });

  it("有新消息时把条数一起说", () => {
    const text = buildUserText(msg, {
      lastDeliveredSeq: 124,
      newSinceLastWake: 3,
    });
    assert.ok(
      text.includes(
        "你上次被唤醒时投递到 #124；此后群里新增 3 条没 @ 你的消息。",
      ),
      text,
    );
  });

  it("拿不到条数（关了 announceNewMessageCount）时只写锚点", () => {
    const text = buildUserText(msg, { lastDeliveredSeq: 124 });
    assert.ok(text.includes("（你上次被唤醒时投递到 #124。）"), text);
  });

  it("首次唤醒没有锚点，退回只说条数", () => {
    const text = buildUserText(msg, { newSinceLastWake: 2 });
    assert.ok(
      text.includes("（自你上次被唤醒以来，群里还有 2 条没 @ 你的消息。）"),
      text,
    );
    assert.ok(!text.includes("投递到"), text);
  });

  it("既没锚点也没新消息时整段不出现", () => {
    const text = buildUserText(msg, {});
    assert.ok(!text.includes("新消息"), text);
    assert.ok(!text.includes("投递到"), text);
  });
});
