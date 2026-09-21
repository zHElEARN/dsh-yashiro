import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { HistoryStore } from "../dist/store.js";

/** 临时路径带上用例名与进程号，出问题时一眼看得出是谁留下的 */
const tempPath = (name) =>
  join(tmpdir(), `yashiro-${name}-${process.pid}-${Date.now()}`);

/** 建一个临时历史库，用例跑完自动关掉并删干净（含 WAL 旁文件） */
export function tempStore(name) {
  const dbPath = `${tempPath(name)}.db`;
  const store = new HistoryStore(dbPath);
  after(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(dbPath + suffix, { force: true });
    }
  });
  return store;
}

/** 建一个临时目录，用例跑完自动删掉 */
export function tempDir(name) {
  const dir = tempPath(name);
  mkdirSync(dir, { recursive: true });
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
