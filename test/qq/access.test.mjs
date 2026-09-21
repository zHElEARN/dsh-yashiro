import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildIdReply,
  decideAccess,
  isIdCommand,
} from "../../dist/qq/access.js";

const GROUP = "A22459EFEB65CFF0405CB716510F7C57";
const USER = "04929CA16A512F57CFBCC3AD77A5D640";
const OTHER = "BBB";

const empty = { allowedGroups: [], allowedUsers: [], blockedSenders: [] };
const open = {
  allowedGroups: [GROUP],
  allowedUsers: [USER],
  blockedSenders: [],
};
const group = (peerId, senderId) => ({ scope: "group", peerId, senderId });

describe("decideAccess：白名单 fail closed", () => {
  it("空白名单：群与单聊都拒，理由各自报准", () => {
    const groupDecision = decideAccess(group(GROUP, USER), empty);
    assert.equal(groupDecision.action, "deny-peer");
    assert.equal(groupDecision.reason, "group-not-allowed");

    const c2cDecision = decideAccess(
      { scope: "c2c", peerId: USER, senderId: USER },
      empty,
    );
    assert.equal(c2cDecision.action, "deny-peer");
    assert.equal(c2cDecision.reason, "c2c-not-allowed");
  });

  it("群在白名单 → 放行；不在 → 拒", () => {
    assert.equal(decideAccess(group(GROUP, USER), open).action, "allow");
    assert.equal(decideAccess(group(OTHER, USER), open).action, "deny-peer");
  });

  it("单聊在白名单 → 放行；不在 → 拒", () => {
    assert.equal(
      decideAccess({ scope: "c2c", peerId: USER, senderId: USER }, open).action,
      "allow",
    );
    assert.equal(
      decideAccess({ scope: "c2c", peerId: OTHER, senderId: USER }, open)
        .action,
      "deny-peer",
    );
  });

  it("'*' 不是通配符", () => {
    const star = { allowedGroups: ["*"], allowedUsers: [], blockedSenders: [] };
    assert.equal(decideAccess(group(GROUP, USER), star).action, "deny-peer");
  });
});

describe("decideAccess：黑名单只拦发送者", () => {
  const blocked = {
    allowedGroups: [GROUP],
    allowedUsers: [USER],
    blockedSenders: [OTHER],
  };

  it("黑名单命中 → deny-sender", () => {
    const decision = decideAccess(group(GROUP, OTHER), blocked);
    assert.equal(decision.action, "deny-sender");
    assert.equal(decision.reason, "sender-blocked");
  });

  it("黑名单不影响旁观者", () => {
    assert.equal(decideAccess(group(GROUP, USER), blocked).action, "allow");
  });

  it("黑名单不按昵称匹配", () => {
    assert.equal(
      decideAccess(group(GROUP, "Zhe_Learn"), blocked).action,
      "allow",
    );
  });
});

describe("isIdCommand", () => {
  it("@ + /id → 触发", () => {
    assert.equal(isIdCommand("/id", true), true);
    assert.equal(isIdCommand("  /id  ", true), true);
  });

  it("没 @ 就不触发", () => {
    assert.equal(isIdCommand("/id", false), false);
  });

  it("带参数 / 前缀 / 夹在正文里都不触发", () => {
    assert.equal(isIdCommand("/id foo", true), false);
    assert.equal(isIdCommand("/idabc", true), false);
    assert.equal(isIdCommand("帮我看看 /id 这个命令", true), false);
  });
});

describe("buildIdReply", () => {
  it("群聊：三行，Group OpenID 是群 openid", () => {
    const reply = buildIdReply({
      peerId: GROUP,
      senderId: USER,
      senderName: "Zhe_Learn",
    });
    assert.deepEqual(reply.split("\n"), [
      `Group OpenID: ${GROUP}`,
      `User OpenID: ${USER}`,
      "Nick Name: Zhe_Learn",
    ]);
  });

  it("单聊：没有群，Group OpenID 给会话 id", () => {
    const reply = buildIdReply({ peerId: USER, senderId: USER });
    assert.deepEqual(reply.split("\n"), [
      `Group OpenID: ${USER}`,
      `User OpenID: ${USER}`,
      "Nick Name: ",
    ]);
  });

  it("只有三行，不带任何说明文本", () => {
    const reply = buildIdReply({
      peerId: USER,
      senderId: USER,
      senderName: "Zhe_Learn",
    });
    assert.equal(reply.split("\n").length, 3, reply);
    assert.ok(!reply.includes("allowedGroups"), reply);
    assert.ok(!reply.includes("allowedUsers"), reply);
    assert.ok(!reply.includes("blockedSenders"), reply);
  });
});
