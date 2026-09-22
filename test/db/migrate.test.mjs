/**
 * 迁移的两条守卫：老库升得上去、`db/schema.ts` 与迁移产物不脱节。
 *
 * 对应两类真实事故：插件升级后老用户的库打不开（本项目发生过一次），以及改了
 * `db/schema.ts` 忘了 `pnpm db:generate`（用户机器上的库停在旧 schema）。
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { openHistoryDb } from "../../dist/db/index.js";
import { messages, sessionBindings } from "../../dist/db/schema.js";
import { HistoryStore } from "../../dist/store.js";

/** 随包发布的迁移目录：源码与产物都在仓库根的 drizzle/ 下 */
const PACKAGED_MIGRATIONS = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/** 临时目录带上用例名与进程号，出问题时一眼看得出是谁留下的 */
function tempDir(name) {
  const dir = join(tmpdir(), `yashiro-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const APP = "1905501006";
const GROUP = { appId: APP, scope: "group", peerId: "G1" };

describe("迁移：老库升级", () => {
  const dir = tempDir("migrate-upgrade");
  const migrations = join(dir, "migrations");
  const dbPath = join(dir, "history.db");
  /** 时间戳前缀排序的第一个就是 baseline */
  const [initFolder] = readdirSync(PACKAGED_MIGRATIONS).sort();

  it("补一条新迁移后，老数据还在、账本记两行、新列生效", () => {
    // ① 只有 baseline：等价于「插件跑过一次」的库
    mkdirSync(join(migrations, initFolder), { recursive: true });
    copyFileSync(
      join(PACKAGED_MIGRATIONS, initFolder, "migration.sql"),
      join(migrations, initFolder, "migration.sql"),
    );
    openHistoryDb(dbPath, migrations).$client.close();

    // ② 往老库里放点数据（HistoryStore 用随包那份迁移：账本里已有 baseline，不会重跑）
    const before = new HistoryStore(dbPath);
    before.appendOutbound(GROUP, "旧库里的这句话不能丢");
    before.createSession(GROUP, "sid-old");
    assert.equal(before.count({ appId: APP, peerId: "G1" }), 1);
    before.close();

    // ③ 发新版本：多出一条迁移
    const nextFolder = "20990101000000_add_probe";
    mkdirSync(join(migrations, nextFolder), { recursive: true });
    writeFileSync(
      join(migrations, nextFolder, "migration.sql"),
      "ALTER TABLE `messages` ADD `probe` text;\n",
    );

    // ④ 升级不能抛
    assert.doesNotThrow(() =>
      openHistoryDb(dbPath, migrations).$client.close(),
    );

    // ⑤ 数据、会话绑定都在，插件能照常读
    const after_ = new HistoryStore(dbPath);
    assert.equal(after_.count({ appId: APP, peerId: "G1" }), 1);
    assert.equal(
      after_.search({ appId: APP, peerId: "G1", limit: 10 })[0]?.content,
      "旧库里的这句话不能丢",
    );
    assert.equal(after_.getCurrentSession(GROUP)?.sessionId, "sid-old");
    after_.close();

    // ⑥ 账本与新增的列都落到了库里
    const raw = new DatabaseSync(dbPath);
    assert.deepEqual(
      raw
        .prepare("SELECT name FROM __drizzle_migrations ORDER BY id")
        .all()
        .map((row) => row.name),
      [initFolder, nextFolder],
    );
    assert.ok(
      raw
        .prepare("PRAGMA table_info(messages)")
        .all()
        .some((column) => column.name === "probe"),
    );
    raw.close();
  });
});

describe("迁移：schema.ts 与迁移产物一致", () => {
  const dir = tempDir("migrate-schema");
  const dbPath = join(dir, "history.db");
  // 跑一遍真实迁移建库；之后只用裸连接做结构对比
  new HistoryStore(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  after(() => raw.close());

  it("只有两张业务表 + 迁移账本", () => {
    assert.deepEqual(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      ["__drizzle_migrations", "messages", "session_bindings"],
    );
  });

  for (const table of [messages, sessionBindings]) {
    const config = getTableConfig(table);

    it(`表 ${config.name} 的列、默认值、主键与 schema.ts 一致`, () => {
      const actual = raw.prepare(`PRAGMA table_info(${config.name})`).all();
      assert.deepEqual(
        actual.map((column) => column.name),
        config.columns.map((column) => column.name),
        `列集合不一致 —— 改了 db/schema.ts 是不是忘了 pnpm db:generate？`,
      );

      const primaryKeys = new Set([
        ...config.columns.filter((c) => c.primary).map((c) => c.name),
        ...config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
      ]);

      for (const column of config.columns) {
        const found = actual.find((c) => c.name === column.name);
        assert.ok(found, `${config.name}.${column.name} 在库里不存在`);
        assert.equal(
          found.type.toLowerCase(),
          column.getSQLType().toLowerCase(),
          `${column.name} 的类型`,
        );
        // 主键列跳过 NOT NULL 比对：SQLite 对 `INTEGER PRIMARY KEY`（rowid 别名）报 notnull = 0
        if (!primaryKeys.has(column.name)) {
          assert.equal(
            Boolean(found.notnull),
            column.notNull,
            `${column.name} 的 NOT NULL`,
          );
        }
        assert.equal(
          Boolean(found.pk),
          primaryKeys.has(column.name),
          `${column.name} 的主键`,
        );
        assert.equal(
          normalizeDefault(found.dflt_value),
          normalizeDefault(column.default),
          `${column.name} 的默认值`,
        );
      }

      // AUTOINCREMENT 只在建表 SQL 文本里，PRAGMA 看不到
      if (config.columns.some((column) => column.autoIncrement)) {
        const row = raw
          .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
          .get(config.name);
        assert.match(String(row.sql), /AUTOINCREMENT/);
      }
    });

    it(`表 ${config.name} 的索引与 schema.ts 一致`, () => {
      const actualIndexes = raw
        .prepare(`PRAGMA index_list(${config.name})`)
        .all()
        // origin = c 才是显式建的索引；主键那种自动索引不在这份定义里
        .filter((index) => index.origin === "c")
        .map((index) => ({
          name: index.name,
          unique: Boolean(index.unique),
          columns: raw
            .prepare(`PRAGMA index_info(${index.name})`)
            .all()
            .map((column) => column.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const declaredIndexes = config.indexes
        .map((index) => ({
          name: index.config.name,
          unique: Boolean(index.config.unique),
          columns: index.config.columns.map((column) => column.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      assert.deepEqual(actualIndexes, declaredIndexes);
    });
  }
});

/**
 * 默认值的两种写法归一到一起：schema 里是 JS 值（false），库里存的是 SQL 字面量（false/0），
 * 两者在 SQLite 里等价。空值统一成 undefined。
 */
function normalizeDefault(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = String(value).toLowerCase();
  if (text === "false") return "0";
  if (text === "true") return "1";
  return text;
}
