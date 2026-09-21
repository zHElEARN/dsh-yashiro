import assert from "node:assert/strict";
import { closeSync, ftruncateSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  chunkText,
  classifyMedia,
  formatContent,
  inspectFileForSend,
  normalizeInbound,
} from "../../dist/qq/gateway.js";
import { quotedImage, tempDir } from "../helpers.mjs";

/** 实测到的真实 payload 形态（全量模式下 @ 消息也叫 GROUP_MESSAGE_CREATE） */
const inbound = {
  rawEventType: "GROUP_MESSAGE_CREATE",
  kind: "group",
  senderId: "04929CA16A512F57CFBCC3AD77A5D640",
  senderName: "Zhe_Learn",
  content: " <@423E7675108B24CED2325760E49EE511> hello（回复信息同时带了@）",
  messageId: "ROBOT1.0_xxx",
  timestamp: "2026-09-20T18:27:40+08:00",
  groupOpenid: "A22459EFEB65CFF0405CB716510F7C57",
  mentions: [
    {
      bot: true,
      id: "423E7675108B24CED2325760E49EE511",
      is_you: true,
      username: "Yashiro",
    },
  ],
  msgElements: [
    { content: "我现在在让deepseek夺舍yashiro", message_type: 103 },
  ],
};

describe("formatContent", () => {
  /** 群里的 mentions：机器人自己 + 一个普通群友 */
  const mentions = [
    { id: "BOT1", username: "Yashiro", is_you: true, bot: true },
    { member_openid: "U9", nickname: "张三", is_you: false },
  ];

  it("<@id> 换成 @昵称，@别人 与 @机器人都保留", () => {
    assert.equal(
      formatContent("<@BOT1> <@U9> 你看这个", mentions),
      "@Yashiro @张三 你看这个",
    );
  });

  it("<@!id> 也认", () => {
    assert.equal(
      formatContent("<@!BOT1> hi there", mentions),
      "@Yashiro hi there",
    );
  });

  it("映射不到（或压根没有 mentions）就保留原始标记，不丢信息", () => {
    assert.equal(formatContent("<@UNKNOWN> 说话", mentions), "<@UNKNOWN> 说话");
    assert.equal(formatContent("<@U9> 你好"), "<@U9> 你好");
  });

  it("@ 标记与后面的字贴在一起时也分开", () => {
    assert.equal(formatContent("<@BOT1>/id", mentions), "@Yashiro /id");
  });

  it("表情标记收敛成 [表情]（新旧两种格式）", () => {
    assert.equal(
      formatContent(
        'A<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">B[<face,id=12/>]C',
        mentions,
      ),
      "A[表情]B[表情]C",
    );
  });

  it("无标记的普通消息原样", () => {
    assert.equal(formatContent("普通消息", mentions), "普通消息");
  });
});

describe("normalizeInbound", () => {
  it("@ 被识别", () => {
    assert.equal(normalizeInbound("1905501006", inbound).mentionsBot, true);
  });

  it("正文里的 @ 换成昵称（@机器人 也留）", () => {
    assert.equal(
      normalizeInbound("1905501006", inbound).content,
      "@Yashiro hello（回复信息同时带了@）",
    );
  });

  it("mentions 收成结构化的一列", () => {
    assert.deepEqual(normalizeInbound("1905501006", inbound).mentions, [
      { id: "423E7675108B24CED2325760E49EE511", name: "Yashiro", isYou: true },
    ]);
  });

  it("没有 mentions 时该字段不出现", () => {
    const msg = normalizeInbound("1905501006", {
      ...inbound,
      mentions: undefined,
    });
    assert.ok(!("mentions" in msg));
  });

  it("引用内容带出", () => {
    assert.equal(
      normalizeInbound("1905501006", inbound).quotedContent,
      "我现在在让deepseek夺舍yashiro",
    );
  });

  it("群 openid", () => {
    assert.equal(
      normalizeInbound("1905501006", inbound).peerId,
      "A22459EFEB65CFF0405CB716510F7C57",
    );
  });

  it("非 @ 不误判，也不带引用", () => {
    const msg = normalizeInbound("1905501006", {
      ...inbound,
      content: "hello（不带@的信息）",
      mentions: undefined,
      msgElements: undefined,
    });
    assert.equal(msg.mentionsBot, false);
    assert.equal(msg.quotedContent, undefined);
  });

  it("老事件名仍识别为 @", () => {
    const msg = normalizeInbound("1905501006", {
      ...inbound,
      rawEventType: "GROUP_AT_MESSAGE_CREATE",
      content: " 123456",
      mentions: undefined,
      msgElements: undefined,
    });
    assert.equal(msg.mentionsBot, true);
  });

  it("单聊 peerId = senderId，且每条都算唤醒", () => {
    const msg = normalizeInbound("1905501006", {
      ...inbound,
      kind: "c2c",
      groupOpenid: undefined,
      content: "hi",
      mentions: undefined,
    });
    assert.equal(msg.scope, "c2c");
    assert.equal(msg.peerId, inbound.senderId);
    assert.equal(
      msg.mentionsBot,
      true,
      "单聊没有 @ 的概念，消息就是冲着机器人来的",
    );
  });

  it("频道事件被忽略", () => {
    assert.equal(
      normalizeInbound("1905501006", { ...inbound, kind: "guild" }),
      null,
    );
  });
});

describe("chunkText", () => {
  const many = Array.from({ length: 400 }, (_, i) => `第${i}行内容`).join("\n");

  it("短文本不切", () => {
    assert.equal(chunkText("abc", 4500).length, 1);
  });

  it("切分后无超长", () => {
    assert.ok(chunkText(many, 200).every((c) => c.length <= 200));
  });

  it("切分后内容无损", () => {
    const joined = chunkText(many, 200).join("\n").replace(/\s/g, "");
    assert.equal(joined, many.replace(/\s/g, ""));
  });
});

describe("附件传递", () => {
  it("引用图片 → 附件被抓到且标记来源为 quoted", () => {
    const msg = normalizeInbound("app", quotedImage);
    assert.equal(msg.attachments?.length, 1);
    assert.equal(msg.attachments?.[0]?.from, "quoted");
    assert.ok(
      String(msg.attachments?.[0]?.url).includes("multimedia.nt.qq.com.cn"),
    );
    assert.equal(msg.attachments?.[0]?.width, 1206);
    assert.equal(msg.attachments?.[0]?.height, 2622);
  });

  it("直接附图 → from=current", () => {
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
    assert.equal(own.attachments?.[0]?.from, "current");
  });

  it("语音转写被抓到", () => {
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
    assert.equal(voice.attachments?.[0]?.asrText, "今天天气不错");
  });

  it("两处附件都在", () => {
    const both = normalizeInbound("app", {
      ...quotedImage,
      attachments: [{ content_type: "file", url: "https://example.com/f.pdf" }],
    });
    assert.equal(both.attachments?.length, 2);
  });

  it("只发图不打字时正文只剩那个 @昵称", () => {
    const noText = normalizeInbound("app", {
      ...quotedImage,
      content: " <@BOT>  ",
    });
    assert.equal(noText.content, "@Yashiro");
  });

  it("正文真的空时就是空串（纯图消息）", () => {
    const empty = normalizeInbound("app", { ...quotedImage, content: "" });
    assert.equal(empty.content, "");
  });

  it("纯文本无附件", () => {
    const plain = normalizeInbound("app", {
      ...quotedImage,
      msgElements: undefined,
      attachments: undefined,
    });
    assert.equal(plain.attachments, undefined);
  });

  it("语音只留平台转码后的 WAV", () => {
    const voice = normalizeInbound("app", {
      ...quotedImage,
      msgElements: undefined,
      attachments: [
        {
          content_type: "voice",
          url: "https://example.com/v.silk",
          voice_wav_url: "https://example.com/v.wav",
          asr_refer_text: "今天天气不错",
        },
      ],
    });
    assert.equal(voice.attachments?.[0]?.url, "https://example.com/v.wav");
    assert.equal(voice.attachments?.[0]?.asrText, "今天天气不错");
    assert.ok(!("voiceWavUrl" in (voice.attachments?.[0] ?? {})));
  });

  it("平台没给 WAV 时退回原始语音 URL", () => {
    const voice = normalizeInbound("app", {
      ...quotedImage,
      msgElements: undefined,
      attachments: [{ content_type: "voice", url: "https://e.com/v.silk" }],
    });
    assert.equal(voice.attachments?.[0]?.url, "https://e.com/v.silk");
  });
});

describe("classifyMedia", () => {
  it("按扩展名分出图片/视频/语音", () => {
    assert.equal(classifyMedia("chart.png"), "image");
    assert.equal(classifyMedia("clip.mp4"), "video");
    assert.equal(classifyMedia("note.silk"), "voice");
  });

  it("大小写不敏感", () => {
    assert.equal(classifyMedia("A.JPG"), "image");
    assert.equal(classifyMedia("B.MP4"), "video");
  });

  it("认不出的一律当普通文件", () => {
    assert.equal(classifyMedia("report.pdf"), "file");
    assert.equal(classifyMedia("archive.tar.gz"), "file");
    assert.equal(classifyMedia("noext"), "file");
    assert.equal(classifyMedia(".gitignore"), "file");
  });

  it("目录名里的点不参与判断", () => {
    assert.equal(classifyMedia("/tmp/a.b/c"), "file");
    assert.equal(classifyMedia("/tmp/a.b/c.png"), "image");
  });
});

describe("inspectFileForSend", () => {
  const dir = tempDir("sendfile");

  it("普通文件给出类型/文件名/大小", () => {
    const path = join(dir, "report.pdf");
    writeFileSync(path, "x".repeat(2048));
    assert.deepEqual(inspectFileForSend(path), {
      kind: "file",
      fileName: "report.pdf",
      fileSize: 2048,
    });
  });

  it("图片按 image 上报", () => {
    const path = join(dir, "chart.png");
    writeFileSync(path, "png");
    assert.equal(inspectFileForSend(path).kind, "image");
  });

  it("目录被拒", () => {
    assert.throws(() => inspectFileForSend(dir), /不是一个普通文件/);
  });

  it("不存在的路径被拒", () => {
    assert.throws(
      () => inspectFileForSend(join(dir, "nope.txt")),
      /读不到文件/,
    );
  });

  /**
   * 超限用的是语音（20MB，四类里最小的那个）。用 ftruncate 造稀疏文件，
   * 不占实际磁盘也不慢。
   */
  it("超过平台上限被拒", () => {
    const path = join(dir, "big.mp3");
    const fd = openSync(path, "w");
    ftruncateSync(fd, 20 * 1024 * 1024 + 1);
    closeSync(fd);
    assert.throws(
      () => inspectFileForSend(path),
      /超过 QQ 对语音的 20\.0MB 上限/,
    );
  });
});
