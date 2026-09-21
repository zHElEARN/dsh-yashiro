/**
 * 把 dsh 的 `approval/request` 桥接成 QQ 群里的两个按钮。
 *
 * outcome 是闭合集合，只有 allowed-once 放行；卡片发不出去、那一轮被取消、插件卸载
 * 一律 fail closed（unavailable / cancelled）。按钮点击走 INTERACTION_CREATE，
 * 由 WebSocket 推回来，不需要回调服务器。
 */
import type {
  InlineKeyboard,
  InteractionEvent,
} from "@tencent-connect/qqbot-nodejs";

import type { Logger } from "../core/logger.js";
import type { PeerRef, Scope } from "../core/types.js";

// ── 最小契约（结构化对齐 dsh-user-approval，但不硬依赖那个包） ──

export type ApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";

/** session log 里 tool/call 事件的最小结构（回显被 gate 的命令用） */
interface ApprovalSessionEvent {
  type: string;
  data?: { callId?: unknown; arguments?: unknown };
}

/** dsh 的 Session 里我们只用到这两个成员：事件总数 + 按下标取事件 */
interface ApprovalSessionLike {
  /** 事件总数，就是日志偏移量 */
  seq: number;
  eventAt(seq: number): ApprovalSessionEvent | undefined;
}

export interface ApprovalRequest {
  agent: { id: string; session: ApprovalSessionLike };
  toolName: string;
  /** 关联的 tool/call 事件 id：审批请求本身不带命令行，靠它回日志里找 */
  callId?: string;
  /** 模型写的理由（沙箱升级时就是那行 justification） */
  reason?: string;
  signal?: AbortSignal;
}

/** 发卡片与超时提示的出口，由 gateway 提供 */
export type ApprovalSender = (
  target: PeerRef,
  text: string,
  keyboard?: InlineKeyboard,
) => Promise<unknown>;

/** 只用到 cordis 的两个能力，便于测试时替身 */
export interface ApprovalContext {
  get(name: string): unknown;
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: { prepend?: boolean },
  ): void;
}

// ── button_data 编解码 ──

interface ApprovalButtonData {
  /** QQ 只有一个 interaction 入口，靠这个判别字段路由到对应通道 */
  t: "approval";
  d: "allow" | "deny";
}

export function encodeApprovalButton(decision: "allow" | "deny"): string {
  const data: ApprovalButtonData = { t: "approval", d: decision };
  return JSON.stringify(data);
}

export function decodeApprovalButton(
  raw: string,
): ApprovalButtonData | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalButtonData>;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.t === "approval"
    ) {
      if (parsed.d === "allow" || parsed.d === "deny")
        return { t: "approval", d: parsed.d };
    }
  } catch {
    /* 非 JSON，不是我们的按钮 */
  }
  return undefined;
}

// ── 渲染 ──

/** 命令回显的截断长度 */
const COMMAND_CLIP = 500;

/** 按 callId 倒着回日志里找被 gate 的命令；找不到返回 undefined，回显只是锦上添花 */
export function commandOf(request: ApprovalRequest): string | undefined {
  if (request.callId === undefined) return undefined;
  const session = request.agent.session;

  for (let i = session.seq - 1; i >= 0; i -= 1) {
    const event = session.eventAt(i);
    if (event?.type !== "tool/call") continue;
    const data = event.data;
    if (String(data?.callId) !== String(request.callId)) continue;
    const raw = data?.arguments;
    if (typeof raw !== "string") return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "command" in parsed
      ) {
        const command = (parsed as { command?: unknown }).command;
        if (typeof command === "string") return command;
      }
    } catch {
      /* 非 JSON，回退到原始字符串 */
    }
    return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
  }
  return undefined;
}

/** timeoutMs 是毫秒，与通道内部单位一致 */
export function buildApprovalText(
  request: ApprovalRequest,
  command: string | undefined,
  timeoutMs: number,
): string {
  const lines = ["🔐 **执行审批**", "", `🔧 工具：${request.toolName}`];
  if (command) lines.push("", "```", command, "```");
  if (request.reason) lines.push("", `📝 ${request.reason}`);
  lines.push(
    "",
    `> 👇 点击下方按钮决定是否允许（${Math.round(timeoutMs / 60_000)} 分钟无人处理按拒绝处理）`,
  );
  return lines.join("\n");
}

type ButtonPermission =
  InlineKeyboard["content"]["rows"][number]["buttons"][number]["action"]["permission"];

/**
 * 允许一次 / 拒绝。`group_id` 相同是为了点过一个另一个就变灰，`click_limit: 1`
 * 限制每个按钮只能点一次；按钮在平台侧也只对名单内的人可点。
 */
export function buildApprovalKeyboard(
  approvers: readonly string[],
): InlineKeyboard {
  if (approvers.length === 0) {
    throw new Error(
      "buildApprovalKeyboard 需要非空的审批名单：空名单意味着审批停用，不该发卡片",
    );
  }
  const permission = {
    type: 0,
    specify_user_ids: [...approvers],
  } as ButtonPermission;

  const button = (
    id: string,
    label: string,
    visitedLabel: string,
    style: number,
    decision: "allow" | "deny",
  ) => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      permission,
      click_limit: 1,
      data: encodeApprovalButton(decision),
    },
    group_id: "approval",
  });

  return {
    content: {
      rows: [
        {
          buttons: [
            button("approval-allow", "✅ 允许一次", "✓ 已允许", 1, "allow"),
            button("approval-deny", "❌ 拒绝", "✓ 已拒绝", 0, "deny"),
          ],
        },
      ],
    },
  };
}

// ── 通道 ──

/** pending 以 sessionId 为键：一个群可能有多条会话，按群查会串到别的会话上 */
interface PendingApproval {
  sessionId: string;
  target: PeerRef;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface ApprovalChannelDeps {
  /** 空数组 = 审批停用（谁都不能审批）：不发卡片，请求直接按 unavailable 收场 */
  approvers: readonly string[];
  /** 多久无人处理按拒绝收场（毫秒）；由配置的 approvalTimeoutSeconds 换算而来 */
  timeoutMs: number;
  send: ApprovalSender;
  /** 不是本插件的会话返回 undefined，交回链上其他应答者 */
  findTarget(sessionId: string): PeerRef | undefined;
  /** 这个群/单聊当前用的是哪条会话；没有会话时 undefined */
  currentSessionOf(peer: PeerRef): string | undefined;
  logger: Logger;
}

export class ApprovalChannel {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly deps: ApprovalChannelDeps) {}

  /** 注册 approval/request waterfall；没有 approval 服务时优雅停用 */
  install(ctx: ApprovalContext): void {
    if (ctx.get("approval") === undefined) {
      this.deps.logger.debug("没有 approval 服务，QQ 审批通道停用");
      return;
    }
    ctx.on(
      "approval/request",
      (request: unknown, next: unknown) =>
        this.route(
          request as ApprovalRequest,
          next as () => Promise<ApprovalOutcome>,
        ),
      { prepend: true },
    );
    if (this.deps.approvers.length === 0) {
      this.deps.logger.warn(
        "QQ 审批通道已挂载，但 approvers 为空 —— 审批停用：提权请求一律按 unavailable 处理，没有人能审批",
      );
      return;
    }
    this.deps.logger.info(
      `QQ 审批通道已挂载（可点的人=${this.deps.approvers.join("、")}，超时 ${Math.round(this.deps.timeoutMs / 1000)}s）`,
    );
  }

  /** 返回 ack code（0 成功 / 4 没权限）；undefined = 不是本通道的按钮，交回调用方 */
  handleInteraction(event: InteractionEvent): number | undefined {
    const raw = event.data?.resolved?.button_data;
    if (raw === undefined) return undefined;
    const button = decodeApprovalButton(raw);
    if (button === undefined) return undefined;

    const scope: Scope = event.scene === "group" ? "group" : "c2c";
    const peerId =
      scope === "group"
        ? (event.group_openid ?? "")
        : (event.user_openid ?? "");
    if (peerId === "") return undefined;

    // 一个群可能有多条会话，但待审批的只会是「这个群当前正在用的那条」
    const sessionId = this.deps.currentSessionOf({ scope, peerId });
    if (sessionId === undefined) return undefined;
    const entry = this.pending.get(sessionId);
    if (entry === undefined) return undefined;

    const clicker =
      scope === "group"
        ? (event.group_member_openid ?? event.user_openid)
        : event.user_openid;
    if (!this.deps.approvers.includes(clicker ?? "")) {
      this.deps.logger.warn(`审批按钮被未授权的人点击：${clicker ?? "(未知)"}`);
      return 4;
    }

    this.deps.logger.info(
      `审批${button.d === "allow" ? "允许" : "拒绝"}：${entry.target.scope} ${entry.target.peerId}`,
    );
    this.settle(
      entry.sessionId,
      button.d === "allow" ? "allowed-once" : "rejected",
    );
    return 0;
  }

  /** 插件卸载时调用，避免 Promise 悬挂 */
  cancelAll(): void {
    for (const key of [...this.pending.keys()]) this.settle(key, "cancelled");
  }

  /** 不是本插件的会话就放行给链上其他应答者，web / tui 审批通道可以共存 */
  private async route(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const target = this.deps.findTarget(request.agent.id);
    if (target === undefined) return next();
    return this.park(request.agent.id, target, request);
  }

  private async park(
    sessionId: string,
    target: PeerRef,
    request: ApprovalRequest,
  ): Promise<ApprovalOutcome> {
    const key = sessionId;
    if (request.signal?.aborted) return "cancelled";
    if (this.deps.approvers.length === 0) {
      this.deps.logger.info(`审批停用（approvers 为空），按不可用处理：${key}`);
      return "unavailable";
    }
    if (this.pending.has(key)) {
      this.deps.logger.warn(`该会话已有待审批请求，这一条按不可用处理：${key}`);
      return "unavailable";
    }

    try {
      await this.deps.send(
        target,
        buildApprovalText(request, commandOf(request), this.deps.timeoutMs),
        buildApprovalKeyboard(this.deps.approvers),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`审批卡片发送失败（按不可用处理）：${message}`);
      return "unavailable";
    }

    return await new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = {
        sessionId,
        target,
        resolve,
        timer: setTimeout(() => {
          this.deps.logger.warn(`审批超时未处理，按拒绝收场：${key}`);
          this.settle(key, "rejected");
          void this.notifyTimeout(target);
        }, this.deps.timeoutMs),
      };
      if (request.signal !== undefined) {
        entry.signal = request.signal;
        entry.onAbort = () => this.settle(key, "cancelled");
        request.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(key, entry);
      this.deps.logger.info(`审批卡片已发到 QQ，等待点击：${key}`);
    });
  }

  private settle(key: string, outcome: ApprovalOutcome): void {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    this.pending.delete(key);
    clearTimeout(entry.timer);
    if (entry.onAbort !== undefined && entry.signal !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    entry.resolve(outcome);
  }

  private async notifyTimeout(target: PeerRef): Promise<void> {
    try {
      await this.deps.send(
        target,
        `⏱ ${Math.round(this.deps.timeoutMs / 60_000)} 分钟没人处理，这条审批已按**拒绝**处理。`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`审批超时提示发送失败：${message}`);
    }
  }
}
