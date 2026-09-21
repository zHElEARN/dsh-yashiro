import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContextText,
  buildListText,
  buildSessionText,
  buildSwitchErrorText,
  buildUnknownCommandText,
  buildUsageText,
  isSessionOperator,
  matchSession,
  NO_SESSION_TEXT,
  NOTHING_RUNNING_TEXT,
  parseSessionCommand,
  SESSIONS_PER_PAGE,
  STOPPED_TEXT,
  shortSessionId,
} from "../../dist/qq/session-commands.js";

/** 展示时间固定按 +08:00 格式化（见 core/time.ts），所以下面断言里写死这个口径 */
const at = (iso) => Date.parse(iso);
const T1800 = at("2026-09-20T18:00:00+08:00");
const T1802 = at("2026-09-20T18:02:00+08:00");
const T1805 = at("2026-09-20T18:05:00+08:00");
const T1820 = at("2026-09-20T18:20:00+08:00");

const line = (id, updatedAt, current = false) => ({
  id,
  epoch: 1,
  updatedAt,
  current,
});

describe("parseSessionCommand", () => {
  it("六条指令的基本形态", () => {
    assert.deepEqual(parseSessionCommand("/current"), { kind: "current" });
    assert.deepEqual(parseSessionCommand("/new"), { kind: "new" });
    assert.deepEqual(parseSessionCommand("/switch abc123"), {
      kind: "switch",
      id: "abc123",
    });
    assert.deepEqual(parseSessionCommand("/list"), { kind: "list", page: 1 });
    assert.deepEqual(parseSessionCommand("/list 3"), { kind: "list", page: 3 });
    assert.deepEqual(parseSessionCommand("/context"), { kind: "context" });
    assert.deepEqual(parseSessionCommand("/stop"), { kind: "stop" });
  });

  it("前后空白与重复空格都能容忍", () => {
    assert.deepEqual(parseSessionCommand("  /new  "), { kind: "new" });
    assert.deepEqual(parseSessionCommand("/switch   abc123"), {
      kind: "switch",
      id: "abc123",
    });
  });

  it("指令前面带 @机器人（@昵称 或没映射到的原始标记）也认", () => {
    assert.deepEqual(parseSessionCommand("@Yashiro /new"), { kind: "new" });
    assert.deepEqual(parseSessionCommand("<@BOT1> /switch abc123"), {
      kind: "switch",
      id: "abc123",
    });
    assert.deepEqual(parseSessionCommand("@Yashiro @张三 /list 2"), {
      kind: "list",
      page: 2,
    });
  });

  it("不是指令返回 undefined，@ 正文照常走", () => {
    assert.equal(parseSessionCommand("你好"), undefined);
    assert.equal(parseSessionCommand("帮我看看 /new 这个命令"), undefined);
    assert.equal(parseSessionCommand(""), undefined);
    assert.equal(parseSessionCommand("/id"), undefined, "/id 有自己的处理分支");
  });

  it("`/` 开头但认不出来的一律当未知指令，不丢给模型", () => {
    assert.deepEqual(parseSessionCommand("/233"), {
      kind: "unknown",
      command: "/233",
    });
    assert.deepEqual(parseSessionCommand("@Yashiro /Users/zhelearn/a.md"), {
      kind: "unknown",
      command: "/Users/zhelearn/a.md",
    });
    assert.deepEqual(parseSessionCommand("/newxxx"), {
      kind: "unknown",
      command: "/newxxx",
    });
    assert.deepEqual(parseSessionCommand("/"), {
      kind: "unknown",
      command: "/",
    });
  });

  it("参数不合法回用法，不猜", () => {
    for (const [input, command] of [
      ["/current 1", "current"],
      ["/new 1", "new"],
      ["/context 1", "context"],
      ["/stop 1", "stop"],
      ["/switch", "switch"],
      ["/switch a b", "switch"],
      ["/list abc", "list"],
      ["/list 0", "list"],
      ["/list -1", "list"],
      ["/list 1 2", "list"],
    ]) {
      assert.deepEqual(parseSessionCommand(input), { kind: "usage", command });
    }
  });
});

describe("isSessionOperator", () => {
  it("只有名单内的人能操作会话", () => {
    assert.equal(isSessionOperator("U1", ["U1", "U2"]), true);
    assert.equal(isSessionOperator("U3", ["U1", "U2"]), false);
  });

  it("名单为空时谁都不能用", () => {
    assert.equal(isSessionOperator("U1", []), false);
  });
});

describe("会话指令文案", () => {
  it("没有会话时统一提示 /new", () => {
    assert.equal(buildListText({ sessions: [], total: 0 }, 1), NO_SESSION_TEXT);
  });

  it("/current 报短 ID 和最近使用时间", () => {
    assert.equal(
      buildSessionText("当前会话", line("a".repeat(64), T1800), "最近使用"),
      "当前会话\nSession ID: aaaaaaaa\n最近使用：2026-09-20 18:00:00",
    );
  });

  it("/switch 与 /new 只差标题和时间标签", () => {
    const target = line("c".repeat(64), T1820);
    assert.equal(
      buildSessionText("已切换：", target, "最近使用"),
      "已切换：\nSession ID: cccccccc\n最近使用：2026-09-20 18:20:00",
    );
    assert.equal(
      buildSessionText("已创建并切换：", target, "创建"),
      "已创建并切换：\nSession ID: cccccccc\n创建：2026-09-20 18:20:00",
    );
  });

  it("/list 标出当前、带分页头", () => {
    assert.equal(
      buildListText(
        {
          current: line("a".repeat(64), T1805, true),
          sessions: [
            line("a".repeat(64), T1805, true),
            line("b".repeat(64), T1802),
          ],
          total: 2,
        },
        1,
      ),
      [
        "会话列表（第 1/1 页，共 2 条，按最近使用排序）",
        "▶ aaaaaaaa  2026-09-20 18:05:00  ← 当前",
        "  bbbbbbbb  2026-09-20 18:02:00",
      ].join("\n"),
    );
  });

  it("/list 页码越界单独报，不静默", () => {
    assert.equal(
      buildListText({ sessions: [], total: 3 }, 2),
      "第 2 页不存在，一共 1 页（共 3 条会话）。",
    );
  });

  it("/list 每页 10 条", () => {
    const sessions = Array.from({ length: SESSIONS_PER_PAGE }, (_, i) =>
      line(`${i}`.padStart(8, "0"), i),
    );
    assert.match(
      buildListText({ sessions, total: 25 }, 1),
      /第 1\/3 页，共 25 条/,
    );
  });

  it("/switch 前缀找不到与重名分别有话说", () => {
    assert.match(buildSwitchErrorText("zzz", []), /没找到会话 zzz/);
    const two = [line("a".repeat(64), 1), line(`aa${"b".repeat(62)}`, 2)];
    assert.match(buildSwitchErrorText("a", two), /匹配到 2 条会话/);
  });

  it("switch 与 list 的用法提示", () => {
    assert.match(buildUsageText("switch"), /\/switch <会话 ID>/);
    assert.match(buildUsageText("list"), /\/list \[页数\]/);
  });

  it("/stop 的两句回执", () => {
    assert.match(STOPPED_TEXT, /已停止/);
    assert.match(NOTHING_RUNNING_TEXT, /没有正在跑的回合/);
  });

  it("未知指令的提示带上原名与可用清单", () => {
    const text = buildUnknownCommandText("/233");
    assert.match(text, /未知指令 \/233/);
    assert.match(text, /\/current/);
    assert.match(text, /\/stop/);
    assert.match(text, /\/id/);
  });

  it("短 ID 取前 8 位", () => {
    assert.equal(shortSessionId("0123456789abcdef"), "01234567");
  });
});

describe("matchSession", () => {
  const A = "aaaaaaaa1111";
  const B = "bbbbbbbb2222";
  const A2 = "aaaaaaaa9999";

  it("粘贴列表里显示的 8 位就能命中", () => {
    assert.deepEqual(
      matchSession("aaaaaaaa", [line(A, 1), line(B, 2)]).map((s) => s.id),
      [A],
    );
  });

  it("两条会话前 8 位相同时，多打几位能消歧义", () => {
    const sessions = [line(A, 1), line(A2, 2), line(B, 3)];
    assert.equal(
      matchSession("aaaaaaaa", sessions).length,
      2,
      "只看 8 位应判为歧义",
    );
    assert.deepEqual(
      matchSession("aaaaaaaa9", sessions).map((s) => s.id),
      [A2],
      "多打一位应唯一",
    );
    assert.deepEqual(
      matchSession(A, sessions).map((s) => s.id),
      [A],
    );
  });

  it("找不到或空输入都返回空，不猜一个出来", () => {
    assert.deepEqual(matchSession("zzzz", [line(A, 1)]), []);
    assert.deepEqual(matchSession("", [line(A, 1)]), []);
    assert.deepEqual(matchSession("  ", [line(A, 1)]), []);
  });
});

describe("buildContextText", () => {
  const full = {
    sessionId:
      "1806fe0ded4b3fa1f43f22fbd456fe915dd1e13f90da1624ac3058a45ea0af56",
    createdAt: T1800,
    model: "deepseek-official/deepseek-flash",
    contextTokens: 306122,
    contextWindow: 1000000,
    totalTokens: 307200,
    cacheReadTokens: 305920,
    lastActivityAt: T1805,
    running: false,
    turns: 11,
    steps: 299,
    userMessages: 14,
    toolCalls: 375,
  };

  it("跑过的会话：短 ID、占用比例、累计、历史、最后活动", () => {
    assert.equal(
      buildContextText(full),
      [
        "会话上下文",
        "Session ID: 1806fe0d",
        "创建：2026-09-20 18:00:00",
        "模型：deepseek-official/deepseek-flash",
        "上下文：306.1k / 1m（31%）",
        "累计用量：307.2k（缓存命中 305.9k，99%）",
        "历史：11 轮 · 299 步 · 14 条你的消息 · 375 次工具调用",
        "最后活动：2026-09-20 18:05:00",
      ].join("\n"),
    );
  });

  it("正在跑回合时在最后活动那行标注", () => {
    assert.match(
      buildContextText({ ...full, running: true }),
      /最后活动：2026-09-20 18:05:00（正在跑回合）/,
    );
  });

  it("/new 之后没跑过：模型与占用都显示未知，不编数字", () => {
    assert.equal(
      buildContextText({
        sessionId: "a".repeat(64),
        createdAt: T1800,
        running: false,
        turns: 0,
        steps: 0,
        userMessages: 0,
        toolCalls: 0,
      }),
      [
        "会话上下文",
        "Session ID: aaaaaaaa",
        "创建：2026-09-20 18:00:00",
        "模型：未知（还没跑过回合）",
        "上下文：还没跑过回合",
        "历史：0 轮 · 0 步 · 0 条你的消息 · 0 次工具调用",
        "最后活动：暂无",
      ].join("\n"),
    );
  });

  it("缓存命中不足 100% 时不许四舍五入成 100%", () => {
    const text = buildContextText({
      ...full,
      totalTokens: 307200,
      cacheReadTokens: 305920,
    });
    assert.match(text, /99%/, text);
    assert.ok(!text.includes("100%"), text);
  });

  it("窗口未知时只报占用，不报比例", () => {
    assert.match(
      buildContextText({ ...full, contextWindow: undefined }),
      /上下文：306\.1k\n/,
    );
  });

  it("创建时间缺失时报未知", () => {
    assert.match(
      buildContextText({ ...full, createdAt: undefined }),
      /创建：未知/,
    );
  });
});
