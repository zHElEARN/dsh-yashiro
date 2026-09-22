/**
 * 打开历史库，并把它推进到最新 schema。
 *
 * 迁移目录 `drizzle/` 与 `dist/` 同级、随包发布；drizzle 的 node:sqlite 迁移器是**同步**
 * 实现，所以插件可以在同步的 `apply()` 里直接完成建库 / 升级，不需要 async。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

/** 从模块自身位置解析，源码（src/db/）与产物（dist/db/）都在同一个深度上 */
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * 打开（必要时新建）历史库，保证 schema 已是最新。
 *
 * 迁移失败会抛出：库结构不对时宁可插件加载失败，也不能带着半截 schema 继续跑。
 *
 * @param migrationsFolder 迁移目录；只有测试会传它，用来验证「旧库升级」这条路径
 */
export function openHistoryDb(
  path: string,
  migrationsFolder = MIGRATIONS_FOLDER,
) {
  mkdirSync(dirname(path), { recursive: true });

  const client = new DatabaseSync(path);
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = NORMAL");

  const db = drizzle({ client });
  const failed = migrate(db, { migrationsFolder });
  // migrate 的失败会以返回值形式出现，不能当没看见
  if (failed !== undefined) {
    throw new Error(`历史库迁移未完成（${failed.exitCode}）：${path}`);
  }
  return db;
}

export type HistoryDb = ReturnType<typeof openHistoryDb>;
