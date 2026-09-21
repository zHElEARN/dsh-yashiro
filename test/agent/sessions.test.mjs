import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionIdOf, sessionKeyOf } from "../../dist/agent/sessions.js";

const APP = "1905501006";
const GROUP = { scope: "group", peerId: "G1" };
const C2C = { scope: "c2c", peerId: "U1" };

describe("sessionKeyOf", () => {
  it("形如 yashiro:appId:scope:peerId:epoch", () => {
    assert.equal(sessionKeyOf(APP, GROUP, 1), `yashiro:${APP}:group:G1:1`);
    assert.equal(sessionKeyOf(APP, C2C, 2), `yashiro:${APP}:c2c:U1:2`);
  });

  it("scope 参与区分：同一个 id 在群聊和单聊是两条会话", () => {
    assert.notEqual(
      sessionKeyOf(APP, { scope: "group", peerId: "X" }, 1),
      sessionKeyOf(APP, { scope: "c2c", peerId: "X" }, 1),
    );
  });

  it("不同 appId 不串会话", () => {
    assert.notEqual(sessionKeyOf("a", GROUP, 1), sessionKeyOf("b", GROUP, 1));
  });

  it("epoch 参与区分：同一个群里多条会话互不相同", () => {
    assert.notEqual(sessionKeyOf(APP, GROUP, 1), sessionKeyOf(APP, GROUP, 2));
  });
});

describe("sessionIdOf", () => {
  it("是确定性的 sha256（重启后能 resume 回同一条会话）", () => {
    const key = sessionKeyOf(APP, GROUP, 1);
    assert.equal(sessionIdOf(key), sessionIdOf(key));
    assert.match(String(sessionIdOf(key)), /^[0-9a-f]{64}$/);
  });

  it("不同会话派生出不同 id", () => {
    assert.notEqual(
      sessionIdOf(sessionKeyOf(APP, GROUP, 1)),
      sessionIdOf(sessionKeyOf(APP, { scope: "group", peerId: "G2" }, 1)),
    );
  });

  it("同群不同 epoch 派生出不同 id", () => {
    assert.notEqual(
      sessionIdOf(sessionKeyOf(APP, GROUP, 1)),
      sessionIdOf(sessionKeyOf(APP, GROUP, 2)),
    );
  });
});
