import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APP_ID as APP,
  groupMessageBase as base,
  tempStore,
} from "./helpers.mjs";

const store = tempStore("store");

const GROUP = { appId: APP, scope: "group", peerId: "G1" };

store.append({
  ...base,
  messageId: "m1",
  content: "今天天气不错",
  mentionsBot: false,
  timestamp: "2026-09-20T18:00:00+08:00",
});
store.append({
  ...base,
  messageId: "m2",
  content: "推荐看看这本轻小说",
  mentionsBot: false,
  timestamp: "2026-09-20T18:01:00+08:00",
});
store.append({
  ...base,
  messageId: "m3",
  content: "你帮我查查更新",
  mentionsBot: true,
  timestamp: "2026-09-20T18:02:00+08:00",
});
// 平台可能重推同一条消息，重复的 message_id 必须被忽略
store.append({
  ...base,
  messageId: "m1",
  content: "今天天气不错",
  mentionsBot: false,
  timestamp: "2026-09-20T18:00:00+08:00",
});
store.append({
  ...base,
  scope: "c2c",
  peerId: "U9",
  messageId: "m4",
  content: "私聊消息",
  mentionsBot: true,
  timestamp: "2026-09-20T18:03:00+08:00",
});

describe("HistoryStore.search", () => {
  it("重复 message_id 被忽略", () => {
    assert.equal(
      store.search({ appId: "1905501006", peerId: "G1", limit: 100 }).length,
      3,
    );
  });

  it("关键词检索匹配正文", () => {
    assert.equal(
      store.search({ appId: "1905501006", query: "轻小说", limit: 10 }).length,
      1,
    );
  });

  it("发送者昵称模糊匹配（3 群 + 1 单聊）", () => {
    assert.equal(
      store.search({ appId: "1905501006", sender: "Zhe", limit: 10 }).length,
      4,
    );
  });

  it("发送者按 openid 也能匹配（单聊拿不到昵称）", () => {
    assert.equal(
      store.search({ appId: "1905501006", sender: "U1", limit: 10 }).length,
      4,
    );
  });

  it("会话隔离", () => {
    assert.equal(
      store.search({ appId: "1905501006", peerId: "U9", limit: 10 }).length,
      1,
    );
  });

  it("limit 生效", () => {
    assert.equal(
      store.search({ appId: "1905501006", peerId: "G1", limit: 2 }).length,
      2,
    );
  });
});

describe("HistoryStore.countSince", () => {
  it("excludeMentions 为真时只数非 @ 消息", () => {
    assert.equal(store.countSince(GROUP, 0, true), 2);
    assert.equal(store.countSince(GROUP, 0, false), 3);
  });

  it("时间窗生效", () => {
    assert.equal(
      store.countSince(GROUP, Date.parse("2026-09-20T18:01:30+08:00"), false),
      1,
    );
  });
});

/** 这个群最新的一条（search 默认由近及远） */
const latest = () => store.search({ ...GROUP, limit: 1 })[0];

describe("HistoryStore.appendOutbound", () => {
  it("机器人自己的发言也入库，且标成 SELF / OUTBOUND", () => {
    store.appendOutbound(GROUP, "好的我去查");
    const last = latest();
    assert.equal(last?.content, "好的我去查");
    assert.equal(last?.senderId, "SELF");
    assert.equal(last?.rawEventType, "OUTBOUND");
    assert.equal(last?.mentionsBot, false);
  });
});

describe("HistoryStore 的 JSON 列", () => {
  it("mentions 存进去、读回来是同构的", () => {
    store.append({
      ...base,
      messageId: "m-mentions",
      content: "@Yashiro @张三 你看这个",
      mentionsBot: true,
      mentions: [
        { id: "BOT1", name: "Yashiro", isYou: true },
        { id: "U9", name: "张三" },
      ],
      timestamp: "2026-09-20T18:10:00+08:00",
    });
    const row = store.search({
      appId: APP,
      peerId: "G1",
      query: "你看这个",
      limit: 1,
    })[0];
    assert.deepEqual(row?.mentions, [
      { id: "BOT1", name: "Yashiro", isYou: true },
      { id: "U9", name: "张三" },
    ]);
  });

  it("没有 mentions 时该字段不出现", () => {
    const row = store.search({
      appId: APP,
      peerId: "G1",
      query: "今天天气不错",
      limit: 1,
    })[0];
    assert.equal(row?.mentions, undefined);
  });
});

describe("HistoryStore 会话绑定", () => {
  const bind = (peerId) => ({ appId: APP, scope: "group", peerId });
  const KEY = bind("BIND-G1");
  const OTHER = bind("BIND-G2");

  it("还没建过会话时没有当前会话", () => {
    assert.equal(store.getCurrentSession(KEY), undefined);
  });

  it("新建即成为当前，epoch 从 1 递增", () => {
    const first = store.createSession(KEY, "sid-1");
    assert.equal(first.epoch, 1);
    assert.equal(store.getCurrentSession(KEY)?.sessionId, "sid-1");

    const second = store.createSession(KEY, "sid-2");
    assert.equal(second.epoch, 2);
    assert.equal(store.getCurrentSession(KEY)?.sessionId, "sid-2");
  });

  it("切回旧会话后当前会话跟着变", () => {
    assert.equal(store.setCurrentSession(KEY, 1), true);
    assert.equal(store.getCurrentSession(KEY)?.sessionId, "sid-1");
  });

  it("切到不存在的 epoch 返回 false，当前会话不动", () => {
    assert.equal(store.setCurrentSession(KEY, 99), false);
    assert.equal(store.getCurrentSession(KEY)?.sessionId, "sid-1");
  });

  it("会话按最近使用倒序，touch 能把一条顶上来", () => {
    store.touchSession(KEY, 2);
    assert.deepEqual(
      store.listSessions(KEY, 1, 10).sessions.map((s) => s.sessionId),
      ["sid-2", "sid-1"],
    );
    store.touchSession(KEY, 1);
    assert.deepEqual(
      store.listSessions(KEY, 1, 10).sessions.map((s) => s.sessionId),
      ["sid-1", "sid-2"],
    );
  });

  it("分页与总数", () => {
    const page1 = store.listSessions(KEY, 1, 1);
    assert.equal(page1.sessions.length, 1);
    assert.equal(page1.total, 2);
    const page2 = store.listSessions(KEY, 2, 1);
    assert.equal(page2.sessions.length, 1);
    assert.notEqual(page2.sessions[0].sessionId, page1.sessions[0].sessionId);
    assert.equal(page2.total, 2);
  });

  it("会话按群隔离，别的群看不到", () => {
    assert.equal(store.getCurrentSession(OTHER), undefined);
    assert.equal(store.listSessions(OTHER, 1, 10).total, 0);
  });
});

/** 游标/过滤/统计用一套独立的干净数据，不受上面那些追加的影响 */
const cursorStore = tempStore("store-cursor");
const CURSOR = { appId: APP, scope: "group", peerId: "GC" };
const cursorIds = [];
for (let i = 0; i < 6; i += 1) {
  cursorIds.push(
    cursorStore.append({
      ...base,
      peerId: "GC",
      messageId: `c${i}`,
      content: `第 ${i} 条`,
      mentionsBot: i % 2 === 1,
      timestamp: `2026-09-20T19:0${i}:00+08:00`,
    }),
  );
}

describe("HistoryStore.append 的返回值", () => {
  it("返回这一行的 seq，且递增", () => {
    assert.equal(typeof cursorIds[0], "number");
    assert.ok(cursorIds[5] > cursorIds[0]);
  });

  it("重复 message_id 返回已存在那行的 seq（不新增行）", () => {
    const again = cursorStore.append({
      ...base,
      peerId: "GC",
      messageId: "c0",
      content: "第 0 条",
      mentionsBot: false,
      timestamp: "2026-09-20T19:00:00+08:00",
    });
    assert.equal(again, cursorIds[0]);
    assert.equal(cursorStore.count(CURSOR), 6);
  });
});

describe("HistoryStore 的游标与过滤", () => {
  const ids = (rows) => rows.map((row) => row.seq);

  it("beforeSeq 取更早的那批，afterSeq 取更新的那批", () => {
    assert.deepEqual(
      ids(
        cursorStore.search({ ...CURSOR, beforeSeq: cursorIds[3], limit: 10 }),
      ),
      [cursorIds[2], cursorIds[1], cursorIds[0]],
    );
    assert.deepEqual(
      ids(
        cursorStore.search({
          ...CURSOR,
          afterSeq: cursorIds[2],
          order: "asc",
          limit: 10,
        }),
      ),
      [cursorIds[3], cursorIds[4], cursorIds[5]],
    );
  });

  it("mentionsMe 只看（不）@ 机器人的", () => {
    assert.equal(
      cursorStore.search({ ...CURSOR, mentionsMe: true, limit: 10 }).length,
      3,
    );
    assert.equal(
      cursorStore.search({ ...CURSOR, mentionsMe: false, limit: 10 }).length,
      3,
    );
  });

  it("query 命中引用正文", () => {
    cursorStore.append({
      ...base,
      peerId: "GC",
      messageId: "c-quote",
      content: "接着说",
      mentionsBot: false,
      quotedContent: "被引用的独特字样",
      timestamp: "2026-09-20T19:09:00+08:00",
    });
    const rows = cursorStore.search({
      ...CURSOR,
      query: "独特字样",
      limit: 10,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "接着说");
  });

  it("count 与 search 用同一套过滤，数字对得上", () => {
    assert.equal(cursorStore.count(CURSOR), 7);
    assert.equal(cursorStore.count({ ...CURSOR, mentionsMe: true }), 3);
    assert.equal(cursorStore.count({ ...CURSOR, beforeSeq: cursorIds[3] }), 3);
    assert.equal(cursorStore.search({ ...CURSOR, limit: 2 }).length, 2);
  });

  it("stats 给整个会话的总量与时间跨度", () => {
    const stats = cursorStore.stats(CURSOR);
    assert.equal(stats.total, 7);
    assert.equal(stats.firstTs, Date.parse("2026-09-20T19:00:00+08:00"));
    assert.equal(stats.lastTs, Date.parse("2026-09-20T19:09:00+08:00"));
  });

  it("空会话的 stats 没有时间跨度", () => {
    const empty = cursorStore.stats({ ...CURSOR, peerId: "GC-EMPTY" });
    assert.deepEqual(empty, { total: 0 });
  });
});

describe("HistoryStore 的引用者解析", () => {
  it("按 msg_idx 反查出被引用那条的说话人", () => {
    store.append({
      ...base,
      peerId: "GQ",
      messageId: "q-src",
      msgIdx: "REF-Q",
      senderId: "U9",
      senderName: "原话的人",
      content: "原话",
      mentionsBot: false,
      timestamp: "2026-09-20T20:00:00+08:00",
    });
    store.append({
      ...base,
      peerId: "GQ",
      messageId: "q-dst",
      senderId: "U8",
      senderName: "接话的人",
      content: "接话",
      quotedContent: "原话",
      quotedMsgIdx: "REF-Q",
      mentionsBot: false,
      timestamp: "2026-09-20T20:01:00+08:00",
    });
    const row = store.search({
      appId: APP,
      peerId: "GQ",
      query: "接话",
      limit: 1,
    })[0];
    assert.equal(row.quotedSenderName, "原话的人");
    assert.equal(row.quotedSenderId, "U9");
  });

  it("同名的 msg_idx 出现在别的群时不串号", () => {
    store.append({
      ...base,
      peerId: "GQ2",
      messageId: "q-src-2",
      msgIdx: "REF-Q",
      senderId: "U7",
      senderName: "另一个群的人",
      content: "另一个群的原话",
      mentionsBot: false,
      timestamp: "2026-09-20T20:02:00+08:00",
    });
    const row = store.search({
      appId: APP,
      peerId: "GQ",
      query: "接话",
      limit: 1,
    })[0];
    assert.equal(row.quotedSenderName, "原话的人");
  });

  it("解析不到就不给说话人，而不是编一个", () => {
    store.append({
      ...base,
      peerId: "GQ",
      messageId: "q-dangling",
      content: "接了个外来的",
      quotedContent: "外来的原话",
      quotedMsgIdx: "REF-NOPE",
      mentionsBot: false,
      timestamp: "2026-09-20T20:03:00+08:00",
    });
    const row = store.search({
      appId: APP,
      peerId: "GQ",
      query: "接了个外来的",
      limit: 1,
    })[0];
    assert.equal(row.quotedSenderName, undefined);
    assert.equal(row.quotedSenderId, undefined);
  });
});
