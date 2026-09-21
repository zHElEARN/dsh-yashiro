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
      store.search({ appId: "1905501006", senderName: "Zhe", limit: 10 })
        .length,
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
