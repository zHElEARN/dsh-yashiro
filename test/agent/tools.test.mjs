import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAgentTools,
  createHistoryTool,
  createSendFileTool,
  createSendTool,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
} from "../../dist/agent/tools.js";
import {
  APP_ID as APP,
  groupMessageBase as base,
  tempStore,
} from "../helpers.mjs";

const store = tempStore("tools");

/**
 * 夹具按**时间正序**灌进去：`seq` 是入库顺序，窗口与游标都按它排，跟真实流量一致
 * （真实环境里只有消息晚到才会两者不同序，那种情况由 store 的用例单独覆盖）。
 */
// 被引用那条（要靠平台序号 msg_idx 才能反查出说话人）
store.append({
  ...base,
  messageId: "m-quote-src",
  msgIdx: "REF-1",
  senderId: "U2",
  senderName: "小刚",
  content: "被引用的原话",
  mentionsBot: false,
  timestamp: "2026-09-19T09:00:00+08:00",
});

// 附件消息：一条引用+双向附件，一条只有附件（用来验证 query 能命中文件名）
store.append({
  ...base,
  messageId: "m-attach",
  content: "看这张图",
  mentionsBot: true,
  quotedContent: "被引用的原话",
  quotedMsgIdx: "REF-1",
  attachments: [
    {
      contentType: "image/jpeg",
      from: "current",
      url: "https://example.com/a.jpg",
      filename: "a.jpg",
      size: 20480,
      width: 800,
      height: 600,
    },
    {
      contentType: "voice",
      from: "quoted",
      url: "https://example.com/v.silk",
      asrText: "今天天气不错",
    },
  ],
  timestamp: "2026-09-19T10:00:00+08:00",
});
store.append({
  ...base,
  messageId: "m-pdf",
  content: "报表在这",
  mentionsBot: false,
  attachments: [
    {
      contentType: "file",
      from: "current",
      url: "https://example.com/report.pdf",
      filename: "季度报表.pdf",
      size: 2048,
    },
  ],
  timestamp: "2026-09-19T11:00:00+08:00",
});

/**
 * 填充数据：条数要顶过 HISTORY_MAX_LIMIT，否则「默认条数」和「上限夹取」这两个边界
 * 会因为库里一共就没几条而失去意义。时间早于下面那个窗口，窗口内的断言不受影响。
 */
const ANCHOR_TS = Date.parse("2026-09-20T18:00:00+08:00");
for (let i = 0; i < HISTORY_MAX_LIMIT * 4; i += 1) {
  store.append({
    ...base,
    messageId: `f${i}`,
    content: `第 ${i} 条填充消息`,
    mentionsBot: false,
    timestamp: new Date(ANCHOR_TS - (i + 1) * 60_000).toISOString(),
  });
}

/** 窗口最前面这 7 条：比所有填充数据都新 */
for (let i = 0; i < 5; i += 1) {
  store.append({
    ...base,
    messageId: `h${i}`,
    content: `第 ${i} 条消息`,
    mentionsBot: i === 1,
    timestamp: `2026-09-20T18:0${i}:00+08:00`,
  });
}
store.append({
  ...base,
  messageId: "long",
  content: "x".repeat(900),
  mentionsBot: false,
  timestamp: "2026-09-20T18:09:00+08:00",
});
// 换行、缩进、空行都必须原样交到模型手里（以前会被压成一行）
store.append({
  ...base,
  messageId: "multi",
  content: "第一行\n  缩进的两个空格\n\n空行之后",
  mentionsBot: true,
  timestamp: "2026-09-20T18:10:00+08:00",
});

const config = { appId: APP };
const sent = [];
const sentFiles = [];
const gateway = {
  async send(peer, text) {
    sent.push({ ...peer, text });
  },
  async sendFile(peer, localPath) {
    sentFiles.push({ ...peer, localPath });
    return { kind: "file", fileName: "report.pdf", fileSize: 2048 };
  },
};
/** 这个群最新的一条（search 默认由近及远） */
const latest = () => store.search({ appId: APP, peerId: "G1", limit: 1 })[0];

const deps = {
  store,
  gateway,
  config,
  peer: { scope: "group", peerId: "G1" },
};

/** 跑一次工具并把给模型看的那段文本取出来 */
async function ask(args) {
  const tool = createHistoryTool(deps);
  const value = await tool.execute(args, {});
  return { value, text: tool.output.render(args, value)[0].text };
}

/** 头部第一行（现在时间 / 总量 / 跨度）与第二行（本次 / 游标） */
const head = (text) => text.split("\n").slice(0, 2);

describe("qqbot_history 的条数与排序", () => {
  it("不传 limit 时用默认条数", async () => {
    const { value } = await ask({});
    assert.equal(value.returned, HISTORY_DEFAULT_LIMIT);
  });

  it("limit 被夹在上限内，并在头部说明要了多少", async () => {
    const { value, text } = await ask({ limit: 999 });
    assert.equal(value.returned, HISTORY_MAX_LIMIT);
    assert.equal(value.limitAsked, 999);
    assert.ok(text.includes(`你要了 999 条，上限 ${HISTORY_MAX_LIMIT}`), text);
  });

  it("结果按时间正序", async () => {
    const { value } = await ask({ limit: 3 });
    assert.deepEqual(
      value.messages.map((m) => m.sender),
      ["Zhe_Learn", "Zhe_Learn", "Zhe_Learn"],
    );
    // 窗口最前面三条按时间正序给出：h4、超长那条、带换行那条
    assert.deepEqual(
      value.messages.map((m) => m.content),
      ["第 4 条消息", "x".repeat(900), "第一行\n  缩进的两个空格\n\n空行之后"],
    );
  });
});

describe("qqbot_history 的正文保真", () => {
  it("长消息原样返回，不截断", async () => {
    const { value } = await ask({ query: "xxxx" });
    assert.equal(value.messages[0].content, "x".repeat(900));
    assert.ok(!value.messages[0].content.includes("已截断"));
  });

  it("换行、缩进与空行都原样保留", async () => {
    const { value, text } = await ask({ query: "缩进的两个空格" });
    assert.equal(
      value.messages[0].content,
      "第一行\n  缩进的两个空格\n\n空行之后",
    );
    assert.ok(text.includes("第一行\n  缩进的两个空格\n\n空行之后"), text);
  });
});

describe("qqbot_history 的附件与引用", () => {
  it("附件按「本条 / 引用」分组，带类型、尺寸、URL 与转写", async () => {
    const { value } = await ask({ query: "看这张图" });
    assert.equal(value.returned, 1);
    assert.deepEqual(value.messages[0].attachments, [
      {
        from: "current",
        text: "图片 a.jpg 800x600 20.0KB  https://example.com/a.jpg",
      },
      {
        from: "quoted",
        text: "语音  https://example.com/v.silk  转写：今天天气不错",
      },
    ]);
  });

  it("render 里两种附件分开标注", async () => {
    const { text } = await ask({ query: "看这张图" });
    assert.match(text, /\n {2}↳ 本条附件：图片 a\.jpg 800x600 20\.0KB/);
    assert.match(
      text,
      /\n {2}↳ 引用附件：语音 {2}https:\/\/example\.com\/v\.silk/,
    );
  });

  it("被引用的是谁说的，从库里反查出来", async () => {
    const { value, text } = await ask({ query: "看这张图" });
    assert.equal(value.messages[0].quotedFrom, "小刚");
    assert.equal(value.messages[0].quotedText, "被引用的原话");
    assert.match(text, /\n {2}↳ 引用 小刚：被引用的原话/);
  });

  it("引用解析不到说话人时就不写说话人", async () => {
    store.append({
      ...base,
      messageId: "m-quote-dangling",
      content: "引用了一条我们没见过的",
      mentionsBot: false,
      quotedContent: "外来的原话",
      quotedMsgIdx: "REF-NOT-IN-DB",
      timestamp: "2026-09-20T18:20:00+08:00",
    });
    const { value, text } = await ask({ query: "引用了一条我们没见过的" });
    assert.equal(value.messages[0].quotedFrom, undefined);
    assert.match(text, /\n {2}↳ 引用：外来的原话/);
  });

  it("没有附件的消息根本不带 attachments 字段", async () => {
    const { value } = await ask({ query: "第 3 条消息" });
    assert.equal(value.returned, 1);
    assert.ok(!("attachments" in value.messages[0]));
  });

  it("query 也能命中附件文件名", async () => {
    const { value } = await ask({ query: "季度报表" });
    assert.equal(value.returned, 1);
    assert.equal(value.messages[0].content, "报表在这");
  });
});

describe("qqbot_history 的元信息与游标", () => {
  it("头部给出现在时间、会话总量与时间跨度", async () => {
    const { value, text } = await ask({ limit: 5 });
    const [first, second] = head(text);
    assert.match(
      first,
      /^现在 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00（周.）｜本群共 \d+ 条（\d{2}-\d{2} \d{2}:\d{2} → \d{2}-\d{2} \d{2}:\d{2}）$/,
    );
    assert.equal(value.total, value.returned + value.older + value.newer);
    assert.equal(value.where, "群");
    assert.match(
      second,
      /^本次 5 条｜同条件下更早还有 \d+ 条：before_seq=\d+$/,
    );
  });

  it("用头部给的 before_seq 就能翻到更早那批，且不重不漏", async () => {
    const newer = await ask({ limit: 5 });
    const older = await ask({ before_seq: newer.value.olderCursor, limit: 5 });
    const newerIds = newer.value.messages.map((m) => m.id);
    const olderIds = older.value.messages.map((m) => m.id);
    assert.ok(Math.max(...olderIds) < Math.min(...newerIds));
    assert.equal(older.value.messages.length, 5);
    assert.ok(older.value.newer > 0);
  });

  it("after_seq 往后取更新的，从锚点之后最早的那条开始", async () => {
    const window = await ask({ limit: 5 });
    const anchor = window.value.messages[0].id;
    const forward = await ask({ after_seq: anchor, limit: 3 });
    assert.deepEqual(
      forward.value.messages.map((m) => m.id),
      window.value.messages.slice(1, 4).map((m) => m.id),
    );
  });

  it("取全了就不给游标", async () => {
    const { value, text } = await ask({ query: "季度报表" });
    assert.equal(value.older, 0);
    assert.equal(value.newer, 0);
    assert.ok(text.includes("已取全"), text);
  });

  it("查不到时头部照给，方便判断是窗口选错还是真没有", async () => {
    const { value, text } = await ask({ query: "根本不存在的内容" });
    assert.equal(value.returned, 0);
    assert.ok(text.includes("（没有符合条件的消息）"), text);
    assert.match(head(text)[0], /^现在 /);
  });
});

describe("qqbot_history 的过滤", () => {
  it("mentions_me: false 只看没 @ 机器人的", async () => {
    const { value } = await ask({
      query: "第 1 条",
      mentions_me: false,
      limit: 10,
    });
    assert.equal(value.returned, 1);
    assert.equal(value.messages[0].mentionsMe, false);
    assert.ok(value.messages[0].content.includes("填充"));
  });

  it("mentions_me: true 只看 @ 了机器人的", async () => {
    const { value } = await ask({
      query: "第 1 条",
      mentions_me: true,
      limit: 10,
    });
    assert.equal(value.returned, 1);
    assert.equal(value.messages[0].mentionsMe, true);
    assert.equal(value.messages[0].content, "第 1 条消息");
  });

  it("sender 按昵称匹配", async () => {
    const { value } = await ask({ sender: "小刚", limit: 10 });
    assert.equal(value.returned, 1);
    assert.equal(value.messages[0].sender, "小刚");
  });

  it("sender 按 openid 也能匹配", async () => {
    const { value } = await ask({ sender: "U2", limit: 10 });
    assert.equal(value.returned, 1);
    assert.equal(value.messages[0].sender, "小刚");
  });

  it("since 与 until 支持 ISO 8601 字符串", async () => {
    const { value } = await ask({
      since: "2026-09-20T18:09:00+08:00",
      until: "2026-09-20T18:15:00+08:00",
      limit: 50,
    });
    assert.deepEqual(
      value.messages.map((m) => m.content),
      ["x".repeat(900), "第一行\n  缩进的两个空格\n\n空行之后"],
    );
  });

  it("since_minutes 只看最近 N 分钟", async () => {
    // 库里最新一条是 2026-09-20 18:10，而"现在"远晚于它 → 窗口内没有消息
    const { value } = await ask({ since_minutes: 5 });
    assert.equal(value.returned, 0);
  });

  it("before_seq 与 after_seq 互斥", async () => {
    await assert.rejects(
      () =>
        createHistoryTool(deps).execute({ before_seq: 1, after_seq: 2 }, {}),
      /只能给一个/,
    );
  });

  it("since 与 since_minutes 互斥", async () => {
    await assert.rejects(
      () =>
        createHistoryTool(deps).execute(
          { since: "2026-09-20T18:00:00+08:00", since_minutes: 10 },
          {},
        ),
      /只能给一个/,
    );
  });

  it("认不出的时间会报错，而不是悄悄当成不限", async () => {
    await assert.rejects(
      () => createHistoryTool(deps).execute({ since: "昨天下午" }, {}),
      /认不出这个时间/,
    );
  });

  it("query 里的 % 与 _ 按字面量处理", async () => {
    store.append({
      ...base,
      messageId: "m-percent",
      content: "进度 100% 了",
      mentionsBot: false,
      timestamp: "2026-09-20T18:30:00+08:00",
    });
    const hit = await ask({ query: "100%" });
    assert.equal(hit.value.returned, 1);
    const miss = await ask({ query: "100x" });
    assert.equal(miss.value.returned, 0);
  });
});

describe("qqbot_send", () => {
  it("发出去（不再切分、也不再回报条数）", async () => {
    sent.length = 0;
    const result = await createSendTool(deps).execute({ text: "收到" }, {});
    assert.deepEqual(result, {});
    assert.deepEqual(sent, [{ scope: "group", peerId: "G1", text: "收到" }]);
  });

  it("超长文本原样交给网关，由它抛错（不在这里截断）", async () => {
    sent.length = 0;
    const long = "x".repeat(6000);
    await createSendTool(deps).execute({ text: long }, {});
    assert.equal(sent[0]?.text.length, 6000);
  });

  it("自己发的内容也落库，标成 SELF / OUTBOUND", async () => {
    await createSendTool(deps).execute({ text: "我查完了" }, {});
    const last = latest();
    assert.equal(last?.content, "我查完了");
    assert.equal(last?.senderId, "SELF");
    assert.equal(last?.rawEventType, "OUTBOUND");
  });
});

describe("qqbot_send_file", () => {
  it("发出去并把出站记录也落库", async () => {
    sentFiles.length = 0;
    const result = await createSendFileTool(deps).execute(
      { file_path: "/tmp/report.pdf" },
      {},
    );
    assert.deepEqual(result, {
      kind: "file",
      fileName: "report.pdf",
      fileSize: 2048,
    });
    assert.deepEqual(sentFiles, [
      { scope: "group", peerId: "G1", localPath: "/tmp/report.pdf" },
    ]);

    const last = latest();
    assert.equal(last?.content, "[文件] report.pdf（2.0KB）");
    assert.equal(last?.rawEventType, "OUTBOUND");
    assert.deepEqual(last?.attachments, [
      {
        contentType: "application/pdf",
        from: "current",
        filename: "report.pdf",
        size: 2048,
      },
    ]);
  });

  it("绝对路径原样透传", async () => {
    sentFiles.length = 0;
    await createSendFileTool(deps).execute({ file_path: "/var/tmp/a.png" }, {});
    assert.equal(sentFiles[0].localPath, "/var/tmp/a.png");
  });

  it("相对路径按 agent 工作目录解析", async () => {
    sentFiles.length = 0;
    const scoped = { ...deps, config: { ...config, cwd: "/tmp/ws" } };
    await createSendFileTool(scoped).execute(
      { file_path: "out/chart.png" },
      {},
    );
    assert.equal(sentFiles[0].localPath, "/tmp/ws/out/chart.png");
  });

  it("空路径被拒", async () => {
    await assert.rejects(
      () => createSendFileTool(deps).execute({ file_path: "   " }, {}),
      /file_path 不能为空/,
    );
  });

  it("发送失败时不落库", async () => {
    const before = latest()?.seq;
    const failing = {
      ...deps,
      gateway: {
        ...gateway,
        async sendFile() {
          throw new Error("平台拒绝：没有文件消息权限");
        },
      },
    };
    await assert.rejects(
      () =>
        createSendFileTool(failing).execute({ file_path: "/tmp/x.pdf" }, {}),
      /没有文件消息权限/,
    );
    assert.equal(latest()?.seq, before);
  });
});

describe("createAgentTools", () => {
  it("一次给出三个工具", () => {
    assert.deepEqual(
      createAgentTools(deps).map((tool) => tool.name),
      ["qqbot_history", "qqbot_send", "qqbot_send_file"],
    );
  });
});
