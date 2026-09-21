import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { HistoryStore } from "../dist/store.js";

const dbPath = join(tmpdir(), `yashiro-test-${process.pid}-${Date.now()}.db`);
const store = new HistoryStore(dbPath);

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

const base = {
  appId: "1905501006",
  scope: "group",
  peerId: "G1",
  senderId: "U1",
  senderName: "Zhe_Learn",
  rawEventType: "GROUP_MESSAGE_CREATE",
};

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

describe("HistoryStore.recent", () => {
  it("按时间正序返回", () => {
    const ids = store.recent("1905501006", "G1", 10).map((r) => r.messageId);
    assert.equal(ids.join(","), "m1,m2,m3");
  });
});

describe("HistoryStore.countSince", () => {
  it("只数非 @ 消息", () => {
    assert.equal(store.countSince("1905501006", "G1", 0, true), 2);
  });

  it("不排除 @ 消息时数全部", () => {
    assert.equal(store.countSince("1905501006", "G1", 0, false), 3);
  });

  it("时间窗生效", () => {
    assert.equal(
      store.countSince(
        "1905501006",
        "G1",
        Date.parse("2026-09-20T18:01:30+08:00"),
        false,
      ),
      1,
    );
  });
});

describe("HistoryStore.lastTs", () => {
  it("返回该会话最后一条消息的时间", () => {
    assert.equal(
      store.lastTs("1905501006", "G1"),
      Date.parse("2026-09-20T18:02:00+08:00"),
    );
  });
});

describe("HistoryStore.appendOutbound", () => {
  it("机器人自己的发言也入库，且标成 SELF / OUTBOUND", () => {
    store.appendOutbound("1905501006", "group", "G1", "好的我去查");
    const last = store.recent("1905501006", "G1", 10).at(-1);
    assert.equal(last?.content, "好的我去查");
    assert.equal(last?.senderId, "SELF");
    assert.equal(last?.rawEventType, "OUTBOUND");
    assert.equal(last?.mentionsBot, false);
  });
});

describe("HistoryStore 会话绑定", () => {
  const APP = "1905501006";
  const PEER = "BIND-G1";
  const OTHER = "BIND-G2";

  it("还没建过会话时没有当前会话", () => {
    assert.equal(store.getCurrentSession(APP, "group", PEER), undefined);
  });

  it("新建即成为当前，epoch 从 1 递增", () => {
    const first = store.createSession(APP, "group", PEER, "sid-1");
    assert.equal(first.epoch, 1);
    assert.equal(
      store.getCurrentSession(APP, "group", PEER)?.sessionId,
      "sid-1",
    );

    const second = store.createSession(APP, "group", PEER, "sid-2");
    assert.equal(second.epoch, 2);
    assert.equal(
      store.getCurrentSession(APP, "group", PEER)?.sessionId,
      "sid-2",
    );
  });

  it("切回旧会话后当前会话跟着变", () => {
    assert.equal(store.setCurrentSession(APP, "group", PEER, 1), true);
    assert.equal(
      store.getCurrentSession(APP, "group", PEER)?.sessionId,
      "sid-1",
    );
  });

  it("切到不存在的 epoch 返回 false，当前会话不动", () => {
    assert.equal(store.setCurrentSession(APP, "group", PEER, 99), false);
    assert.equal(
      store.getCurrentSession(APP, "group", PEER)?.sessionId,
      "sid-1",
    );
  });

  it("会话按最近使用倒序，touch 能把一条顶上来", () => {
    store.touchSession(APP, "group", PEER, 2);
    assert.deepEqual(
      store
        .listSessions(APP, "group", PEER, 1, 10)
        .sessions.map((s) => s.sessionId),
      ["sid-2", "sid-1"],
    );
    store.touchSession(APP, "group", PEER, 1);
    assert.deepEqual(
      store
        .listSessions(APP, "group", PEER, 1, 10)
        .sessions.map((s) => s.sessionId),
      ["sid-1", "sid-2"],
    );
  });

  it("分页与总数", () => {
    const page1 = store.listSessions(APP, "group", PEER, 1, 1);
    assert.equal(page1.sessions.length, 1);
    assert.equal(page1.total, 2);
    const page2 = store.listSessions(APP, "group", PEER, 2, 1);
    assert.equal(page2.sessions.length, 1);
    assert.notEqual(page2.sessions[0].sessionId, page1.sessions[0].sessionId);
    assert.equal(page2.total, 2);
  });

  it("会话按群隔离，别的群看不到", () => {
    assert.equal(store.getCurrentSession(APP, "group", OTHER), undefined);
    assert.equal(store.listSessions(APP, "group", OTHER, 1, 10).total, 0);
  });
});
