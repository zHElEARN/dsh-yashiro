import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildApprovalKeyboard,
  buildApprovalText,
  commandOf,
  decodeApprovalButton,
  encodeApprovalButton,
} from "../../dist/qq/approval.js";

/** session 侧只用到 seq + eventAt，dsh 的 Session 就是这么给的 */
const sessionOf = (events) => ({
  seq: events.length,
  eventAt: (i) => events[i],
});

const toolCall = (command) => ({
  type: "tool/call",
  data: {
    callId: "c1",
    arguments: JSON.stringify({ command, description: "清理" }),
  },
});

const request = {
  agent: { id: "s1", session: sessionOf([toolCall("rm -rf /tmp/x")]) },
  toolName: "bash",
  callId: "c1",
  reason: "需要写工作区外的文件",
};

describe("button_data 编解码", () => {
  it("往返", () => {
    assert.equal(
      decodeApprovalButton(encodeApprovalButton("allow"))?.d,
      "allow",
    );
  });

  it("别的通道的 button_data 不认", () => {
    assert.equal(
      decodeApprovalButton('{"t":"question","q":"x","i":0}'),
      undefined,
    );
  });

  it("非 JSON 不认", () => {
    assert.equal(decodeApprovalButton("nope"), undefined);
  });
});

describe("buildApprovalKeyboard", () => {
  const buttons = buildApprovalKeyboard([]).content.rows[0].buttons;

  it("两个按钮，都是回调且只能点一次", () => {
    assert.equal(buttons.length, 2);
    assert.ok(
      buttons.every((b) => b.action.type === 1 && b.action.click_limit === 1),
    );
  });

  it("同一 group_id（点一个另一个变灰）", () => {
    assert.equal(buttons[0].group_id, buttons[1].group_id);
  });

  it("approvers 为空 = 所有人可点", () => {
    assert.equal(buttons[0].action.permission.type, 2);
  });

  it("指定审批人：type=0 + specify_user_ids", () => {
    const restricted = buildApprovalKeyboard([
      "04929CA16A512F57CFBCC3AD77A5D640",
    ]).content.rows[0].buttons[0];
    assert.equal(restricted.action.permission.type, 0);
    assert.equal(
      restricted.action.permission.specify_user_ids?.[0],
      "04929CA16A512F57CFBCC3AD77A5D640",
    );
  });
});

describe("commandOf：从 session log 回显被 gate 的命令", () => {
  it("按 callId 倒查 tool/call", () => {
    assert.equal(commandOf(request), "rm -rf /tmp/x");
  });

  it("同一个 callId 出现多次时取最后一条", () => {
    const session = sessionOf([
      toolCall("echo 旧的"),
      { type: "tool/result", data: {} },
      toolCall("echo 新的"),
    ]);
    assert.equal(
      commandOf({ ...request, agent: { id: "s1", session } }),
      "echo 新的",
    );
  });

  it("callId 对不上返回 undefined", () => {
    assert.equal(commandOf({ ...request, callId: "nope" }), undefined);
  });

  it("日志里没有对应事件时返回 undefined，不抛错", () => {
    assert.equal(
      commandOf({ ...request, agent: { id: "s1", session: sessionOf([]) } }),
      undefined,
    );
  });
});

describe("buildApprovalText", () => {
  it("卡片含工具名 / 命令 / 理由 / 超时", () => {
    const card = buildApprovalText(request, commandOf(request), 300_000);
    assert.ok(card.includes("bash"));
    assert.ok(card.includes("rm -rf /tmp/x"));
    assert.ok(card.includes("需要写工作区外的文件"));
    assert.ok(card.includes("5 分钟"));
  });
});
