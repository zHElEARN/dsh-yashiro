/**
 * dsh-yashiro：把 QQ 群消息接进 dsh agent 回合，并把 qqbot_history / qqbot_send /
 * qqbot_send_file 三个工具挂给这个会话专属的 agent。
 *
 * 所有群消息入库；只有 @ 机器人的消息会唤醒 agent，回复完全由它调 qqbot_send 完成。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentSetup } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { summarizeSessionLog } from "./agent/context-info.js";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/prompt.js";
import { SessionManager } from "./agent/sessions.js";
import { createAgentTools } from "./agent/tools.js";
import { Config } from "./core/config.js";
import { describeError } from "./core/errors.js";
import { createLogger } from "./core/logger.js";
import { type ChatKey, chatKey, type PeerRef } from "./core/types.js";
import { buildIdReply, decideAccess, isIdCommand } from "./qq/access.js";
import { ApprovalChannel, type ApprovalContext } from "./qq/approval.js";
import { YashiroGateway } from "./qq/gateway.js";
import { buildUserText } from "./qq/message-text.js";
import {
  buildContextText,
  buildListText,
  buildSessionText,
  buildSwitchErrorText,
  buildUnknownCommandText,
  buildUsageText,
  ID_COMMAND,
  isSessionOperator,
  matchSession,
  NO_SESSION_TEXT,
  parseSessionCommand,
  SESSIONS_PER_PAGE,
  type SessionCommand,
  type SessionLine,
  shortSessionId,
} from "./qq/session-commands.js";
import {
  defaultHistoryDbPath,
  HistoryStore,
  type SessionBinding,
  type StoredMessage,
} from "./store.js";

export const name = "dsh-yashiro";

/**
 * 依赖的 cordis 服务：agent 注册表、默认模型、工具与系统提示词注册表、会话标题。
 *
 * sessionTitle 由 dsh-base 提供，所以实际上一定在；列进来是为了拿到类型。
 */
export const inject = [
  "agents",
  "agentDefaultModel",
  "tools",
  "systemPrompt",
  "sessionTitle",
];

export type { Config as YashiroConfig } from "./core/config.js";
export { Config };

const PLUGIN_ID = "dsh-yashiro";

/** 每个会话记住多少条已处理的消息 ID；超出就丢最早的 */
const DEDUPE_WINDOW = 200;

/** ctx.sessionTitle（@deepseek-ai/dsh-session-title）里用到的最小面 */
interface SessionTitleServiceLike {
  rename(session: unknown, title: string): unknown;
}

export function apply(ctx: Context, config: Config): void {
  const store = new HistoryStore(
    config.historyDbPath?.trim() || defaultHistoryDbPath(),
  );
  const logger = createLogger(ctx.logger, store.path, config.debug);

  /** 上次唤醒 agent 的时间（按会话），用来告诉它「你不在的时候群里又聊了多少」 */
  const lastWakeAt = new Map<string, number>();
  /** 已处理过的消息 ID（按会话），防止平台重推导致重复唤醒 */
  const seenMessages = new Map<string, Set<string>>();

  const sessions = new SessionManager(
    ctx,
    config.appId,
    config.cwd?.trim() || process.cwd(),
    logger,
  );

  // 网关与审批通道互相引用，先声明类型后赋值，避免 TS 的类型推断绕成环
  let gateway: YashiroGateway;

  const approval = new ApprovalChannel({
    approvers: config.approvers,
    timeoutMs: config.approvalTimeoutSeconds * 1000,
    send: (target, text, keyboard) => gateway.sendCard(target, text, keyboard),
    findTarget: (sessionId) => sessions.findTarget(sessionId),
    currentSessionOf: (peer) => store.getCurrentSession(keyOf(peer))?.sessionId,
    logger,
  });

  gateway = new YashiroGateway(
    config,
    {
      onMessage: (msg) => {
        void handleMessage(msg);
      },
      onInteraction: (event) => approval.handleInteraction(event),
    },
    logger,
  );
  approval.install(ctx as unknown as ApprovalContext);

  /** 这个 QQ 会话在历史库里的键（appId 由配置来） */
  function keyOf(peer: PeerRef): ChatKey {
    return chatKey(config.appId, peer);
  }

  /** 建立这个 QQ 会话专属的 agent 世界：三个工具 + 一段系统提示词 */
  function buildSetup(peer: PeerRef): AgentSetup {
    return (agentCtx) => {
      const deps = { store, gateway, config, peer };
      for (const tool of createAgentTools(deps)) {
        agentCtx.tools.register(tool);
      }
      agentCtx.systemPrompt.section({
        name: "dsh-yashiro:channel",
        order: 90,
        text: DEFAULT_SYSTEM_PROMPT,
      });
    };
  }

  /** 发一条纯文本并记进历史；发失败就不记，两处失败都只写日志 */
  async function sendAndRecord(peer: PeerRef, text: string): Promise<void> {
    try {
      await gateway.send(peer, text);
    } catch (err) {
      logger.error(
        `发送到 ${peer.scope} ${peer.peerId} 失败：${describeError(err)}`,
      );
      return;
    }
    try {
      store.appendOutbound(keyOf(peer), text);
    } catch (err) {
      logger.error(`记录出站消息失败: ${describeError(err)}`);
    }
  }

  /** 把一个绑定行翻成展示用的会话行 */
  function toLine(
    session: SessionBinding,
    current: SessionBinding | undefined,
  ): SessionLine {
    return {
      id: session.sessionId,
      epoch: session.epoch,
      updatedAt: session.updatedAt,
      current: current?.sessionId === session.sessionId,
    };
  }

  /** 这个群/单聊的全部会话，按最近使用倒序，标出哪条是当前 */
  function sessionLines(peer: PeerRef): SessionLine[] {
    const key = keyOf(peer);
    const current = store.getCurrentSession(key);
    return store
      .listSessions(key, 1, Number.MAX_SAFE_INTEGER)
      .sessions.map((s) => toLine(s, current));
  }

  /**
   * 给会话起个名字，让它在 web 侧边栏里认得出是哪条。
   *
   * 用 8 位短 ID，和群里 /list、/current 显示的是同一个值。不设的话侧边栏会退回
   * 工作目录名（所有会话都长一样）。
   *
   * rename 写入的标题 source 是 `user`，这个标记会连带禁掉首条消息触发的 LLM 自动
   * 标题 —— 否则我们设的名字会在 agent 第一次回话时被顶掉。
   */
  function titleSession(agent: Agent): void {
    const titles = ctx.get("sessionTitle") as
      | SessionTitleServiceLike
      | undefined;
    if (titles === undefined) return;
    try {
      titles.rename(agent.session, shortSessionId(String(agent.id)));
    } catch (err) {
      logger.warn(`设置会话标题失败（不影响对话）：${describeError(err)}`);
    }
  }

  /**
   * 折叠这条会话的日志，拼出 `/context` 的回复。
   *
   * 连不上会话（比如文件被删了）不当成致命错误：回一句说明，当前会话指针不动。
   */
  async function buildContextReply(
    peer: PeerRef,
    sessionId: string,
  ): Promise<string> {
    const agent = await sessions.select(peer, sessionId, buildSetup(peer));
    if (agent === undefined) {
      return `会话 ${shortSessionId(sessionId)} 连不上（会话文件可能被删了）。`;
    }
    try {
      return buildContextText({
        sessionId,
        ...summarizeSessionLog(agent.session),
      });
    } catch (err) {
      logger.warn(`读取会话日志失败：${describeError(err)}`);
      return "读这条会话的日志失败，详情见插件日志。";
    }
  }

  /**
   * 会话指令的统一出口。
   *
   * 这些指令会改「这个群正在用哪条会话」，所以限审批名单 —— 否则群里任何人都能
   * 把会话换成自己的。被拒时明确回一句，不静默丢弃。
   */
  async function handleSessionCommand(
    msg: StoredMessage,
    command: SessionCommand,
  ): Promise<void> {
    const peer: PeerRef = msg;
    const key = keyOf(peer);
    const reply = (text: string) => sendAndRecord(peer, text);

    // 未知指令对所有人回同一句：它不涉及任何会话操作，也就没有权限可言
    if (command.kind === "unknown") {
      await reply(buildUnknownCommandText(command.command));
      return;
    }

    if (!isSessionOperator(msg.senderId, config.approvers)) {
      logger.info(`会话指令被非名单内的人触发：${msg.senderId}`);
      await reply("只有审批名单里的人能用会话指令。");
      return;
    }

    if (command.kind === "usage") {
      await reply(buildUsageText(command.command));
      return;
    }

    if (command.kind === "current") {
      const current = store.getCurrentSession(key);
      await reply(
        current
          ? buildSessionText("当前会话", toLine(current, current), "最近使用")
          : NO_SESSION_TEXT,
      );
      return;
    }

    if (command.kind === "context") {
      const current = store.getCurrentSession(key);
      await reply(
        current
          ? await buildContextReply(peer, current.sessionId)
          : NO_SESSION_TEXT,
      );
      return;
    }

    if (command.kind === "list") {
      const lines = sessionLines(peer);
      const start = (command.page - 1) * SESSIONS_PER_PAGE;
      await reply(
        buildListText(
          {
            current: lines.find((line) => line.current),
            sessions: lines.slice(start, start + SESSIONS_PER_PAGE),
            total: lines.length,
          },
          command.page,
        ),
      );
      return;
    }

    if (command.kind === "new") {
      try {
        // 先建会话再落绑定：建失败就什么都不落，当前会话与绑定保持原样
        const agent = await sessions.create(
          peer,
          store.nextEpoch(key),
          buildSetup(peer),
        );
        titleSession(agent);
        const binding = store.createSession(key, String(agent.id));
        logger.info(
          `已新建会话：${shortSessionId(String(agent.id))} peer=${peer.peerId}`,
        );
        await reply(
          buildSessionText("已创建并切换：", toLine(binding, binding), "创建"),
        );
      } catch (err) {
        logger.error(`新建会话失败: ${describeError(err)}`);
        await reply("新建会话失败，当前会话没有变化。详情见插件日志。");
      }
      return;
    }

    // /switch：只认自己这个群里的会话；唯一才切，不猜
    const matches = matchSession(command.id, sessionLines(peer));
    const target = matches.length === 1 ? matches[0] : undefined;
    if (target === undefined) {
      await reply(buildSwitchErrorText(command.id, matches));
      return;
    }

    const agent = await sessions.select(peer, target.id, buildSetup(peer));
    if (agent === undefined) {
      await reply(
        `会话 ${shortSessionId(target.id)} 连不上（会话文件可能被删了），当前会话没有变化。`,
      );
      return;
    }
    titleSession(agent);
    store.setCurrentSession(key, target.epoch);
    logger.info(`已切换会话：${shortSessionId(target.id)} peer=${peer.peerId}`);
    await reply(buildSessionText("已切换：", target, "最近使用"));
  }

  async function handleMessage(msg: StoredMessage): Promise<void> {
    const peer: PeerRef = msg;
    const key = keyOf(peer);

    // 入库先于访问控制：白名单只决定「要不要唤醒 agent」，不决定「要不要记录」
    try {
      store.append(msg);
    } catch (err) {
      logger.error(`写入历史库失败: ${describeError(err)}`);
    }

    // `/id` 绕过访问控制：不知道 group openid 就没法配白名单，这个自举口子必须留着
    if (isIdCommand(msg.content, msg.mentionsBot)) {
      await sendAndRecord(peer, buildIdReply(msg));
      logger.info(`已响应 ${ID_COMMAND}：${peer.scope} ${peer.peerId}`);
      return;
    }

    const access = decideAccess(msg, config);
    if (access.action === "deny-peer") {
      logger.info(
        `会话未放行（${access.reason}）：${peer.scope} ${peer.peerId}`,
      );
      return;
    }

    if (!msg.mentionsBot) {
      logger.debug(
        `非 @ 消息，仅入库: ${JSON.stringify(msg.content.slice(0, 40))}`,
      );
      return;
    }

    if (access.action === "deny-sender") {
      logger.info(`发送者在黑名单，跳过唤醒：${msg.senderId}`);
      return;
    }

    const sessionCommand = parseSessionCommand(msg.content);
    if (sessionCommand !== undefined) {
      await handleSessionCommand(msg, sessionCommand);
      return;
    }

    // 没有会话就不建：明确让用户 /new，避免一个 @ 就悄悄开出一条空会话
    const current = store.getCurrentSession(key);
    if (current === undefined) {
      logger.info(`无会话，已提示 ${peer.scope} ${peer.peerId} 用 /new`);
      await sendAndRecord(peer, NO_SESSION_TEXT);
      return;
    }

    // 去重与「上次开口」都按会话记：/new 之后是全新上下文，不该继承旧会话的状态
    const dedupeKey = current.sessionId;
    let seen = seenMessages.get(dedupeKey);
    if (seen === undefined) {
      seen = new Set();
      seenMessages.set(dedupeKey, seen);
    }
    if (seen.has(msg.messageId)) return;
    seen.add(msg.messageId);
    if (seen.size > DEDUPE_WINDOW) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }

    // 首次唤醒不报数，否则 agent 一上来就被告知「有几千条新消息」
    const previousWake = lastWakeAt.get(dedupeKey);
    let newSinceLastWake: number | undefined;
    if (config.announceNewMessageCount && previousWake !== undefined) {
      try {
        newSinceLastWake = store.countSince(key, previousWake, true);
      } catch {
        newSinceLastWake = undefined;
      }
    }

    try {
      const agent = await sessions.select(
        peer,
        current.sessionId,
        buildSetup(peer),
      );
      if (agent === undefined) {
        logger.error(`会话连不上：${shortSessionId(current.sessionId)}`);
        await sendAndRecord(
          peer,
          `当前会话（${shortSessionId(current.sessionId)}）连不上，用 /new 或 /switch 换一条。`,
        );
        return;
      }
      const message = createUserMessage({
        content: [
          { type: "text", text: buildUserText(msg, { newSinceLastWake }) },
        ],
        source: { kind: "plugin", plugin: PLUGIN_ID },
      });
      // queue 是等当前回合结束再开新回合；steer 在当前回合的下一个 step 边界就注入
      if (config.busyDelivery === "queue") agent.followup(message);
      else agent.steer(message);
      store.touchSession(key, current.epoch);
      lastWakeAt.set(dedupeKey, Date.parse(msg.timestamp) || Date.now());
      logger.info(
        `已唤醒 agent：session=${String(agent.id).slice(0, 12)}… peer=${peer.peerId}`,
      );
    } catch (err) {
      logger.error(`唤醒 agent 失败: ${describeError(err)}`);
      await sendAndRecord(peer, "这条消息没能交给 agent，详情见插件日志。");
    }
  }

  gateway.start();
  logger.info(
    `已启动（appId=${config.appId} 沙箱=${config.sandbox} 库=${store.path}）`,
  );

  // effect 返回的函数在本插件 fiber 销毁时执行
  ctx.effect(() => () => {
    logger.info("正在关闭…");
    approval.cancelAll();
    gateway.stop();
    void sessions.disposeAll();
    store.close();
  });
}
