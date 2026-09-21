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

/** 用例里的 appId 用同一个值，方便历史库与工具用例共用夹具 */
export const APP_ID = "1905501006";

/** 一条群消息的公共字段，用例按需覆盖（改 scope / peerId / 正文 / 附件…） */
export const groupMessageBase = {
  appId: APP_ID,
  scope: "group",
  peerId: "G1",
  senderId: "U1",
  senderName: "Zhe_Learn",
  rawEventType: "GROUP_MESSAGE_CREATE",
};

/**
 * 实测到的真实 payload：引用一张纯图片再 @ 机器人 —— 被引用消息没有文字，
 * 附件只挂在 msgElements[0] 上。这条路径必须一直有覆盖，附件送不到 agent 面前时，
 * 它只会看到一条空消息。
 */
export const quotedImage = {
  rawEventType: "GROUP_MESSAGE_CREATE",
  kind: "group",
  senderId: "U1",
  senderName: "Zhe_Learn",
  content: " <@BOT> 你看一下这张图看看是啥",
  messageId: "m-img",
  timestamp: "2026-09-20T19:22:59+08:00",
  groupOpenid: "G1",
  mentions: [{ id: "BOT", username: "Yashiro", is_you: true }],
  msgElements: [
    {
      content: "",
      message_type: 0,
      attachments: [
        {
          content_type: "image/jpeg",
          url: "https://multimedia.nt.qq.com.cn/download?fileid=abc",
          filename: "cat.jpg",
          width: 1206,
          height: 2622,
          size: 1363148,
        },
      ],
    },
  ],
};
