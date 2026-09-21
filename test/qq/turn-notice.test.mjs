import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTurnNoticeText } from "../../dist/qq/turn-notice.js";

describe("buildTurnNoticeText", () => {
  it("error：文案带 code + 一句人话", () => {
    const text = buildTurnNoticeText({
      kind: "error",
      error: { code: "RATE_LIMITED", message: "429 too many requests" },
    });
    assert.match(text, /RATE_LIMITED/);
    assert.ok(!text.includes("429"), "模型原始报错不该进群");
  });

  it("error 认不出 code 时给 UNKNOWN，不编造", () => {
    assert.match(buildTurnNoticeText({ kind: "error" }), /UNKNOWN/);
    assert.match(
      buildTurnNoticeText({ kind: "error", error: { code: "" } }),
      /UNKNOWN/,
    );
    assert.match(
      buildTurnNoticeText({ kind: "error", error: "not-an-object" }),
      /UNKNOWN/,
    );
  });

  it("max-tokens 单独一句（话说了一半）", () => {
    assert.match(buildTurnNoticeText({ kind: "max-tokens" }), /截断/);
  });

  it("其余收尾一律不播报", () => {
    for (const kind of [
      "completed",
      "aborted",
      "blocked",
      "interrupted",
      "something-else",
      undefined,
    ]) {
      assert.equal(buildTurnNoticeText({ kind }), undefined, String(kind));
    }
    assert.equal(buildTurnNoticeText(undefined), undefined);
  });
});
