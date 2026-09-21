import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** 只在 config.debug 打开时落盘 */
  debug(message: string): void;
}

/** ctx.logger 里我们转发的那三档 */
export interface HostLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PREFIX = "[dsh-yashiro] ";

/**
 * 插件日志：转发给 host logger，同时在历史库同目录落一份 plugin.log ——
 * headless profile 下 ctx.logger 没有可见出口，文件是唯一的现场。
 *
 * 前缀在这里统一加，调用方只管写正文。
 */
export function createLogger(
  host: HostLogger,
  dbPath: string,
  debug: boolean,
): Logger {
  const logFile = join(dirname(dbPath), "plugin.log");
  mkdirSync(dirname(logFile), { recursive: true });

  const write = (level: string, message: string): void => {
    if (level === "DEBUG" && !debug) return;
    try {
      appendFileSync(
        logFile,
        `${new Date().toISOString()} [${level}] ${PREFIX}${message}\n`,
      );
    } catch {
      /* 日志写不进去也不能影响主流程 */
    }
  };

  return {
    info: (message) => {
      write("INFO", message);
      host.info(PREFIX + message);
    },
    warn: (message) => {
      write("WARN", message);
      host.warn(PREFIX + message);
    },
    error: (message) => {
      write("ERROR", message);
      host.error(PREFIX + message);
    },
    debug: (message) => write("DEBUG", message),
  };
}
