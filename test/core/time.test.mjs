import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DISPLAY_TIME_ZONE,
  formatTime,
  platformNowIso,
} from "../../dist/core/time.js";

describe("formatTime", () => {
  /**
   * 一律从 epoch 毫秒格式化。直接切时间戳字符串会出错：平台消息带 +08:00，
   * 而出站记录写的是 UTC，切出来会差 8 小时。
   */
  const platform = formatTime(Date.parse("2026-09-20T18:46:10+08:00"));
  const outbound = formatTime(Date.parse("2026-09-20T10:46:10.294Z"));

  it("平台格式 → 18:46:10", () => {
    assert.equal(platform, "2026-09-20 18:46:10");
  });

  it("同一时刻的 UTC 表示 → 同样的显示", () => {
    assert.equal(outbound, platform);
  });

  it("展示时区固定为 Asia/Shanghai", () => {
    assert.equal(DISPLAY_TIME_ZONE, "Asia/Shanghai");
  });
});

describe("platformNowIso", () => {
  it("形如 +08:00", () => {
    assert.match(
      platformNowIso(),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/,
    );
  });

  it("可被 Date.parse", () => {
    assert.ok(Number.isFinite(Date.parse(platformNowIso())));
  });
});
