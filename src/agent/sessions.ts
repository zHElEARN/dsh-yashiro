/**
 * 一个 QQ 会话（群 / 单聊）对应一条 dsh agent 会话。
 *
 * SessionId 由 sessionKey 做 SHA-256 确定性派生，所以不需要映射表：同一来源永远
 * 路由到同一条会话，进程重启后能 resume 回来。以后要做多会话切换，只要往
 * sessionKey 里再拼一维（topic / epoch），派生出来自然就是另一条会话。
 */
import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  ModelSelection,
} from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";

import { describeError } from "../core/errors.js";
import type { ApprovalTarget } from "../qq/approval.js";

interface SessionEntry {
  agent: Agent;
  dispose: () => Promise<void>;
}

/** workspace 域（@deepseek-ai/dsh-workspace）里用到的最小面，避免硬依赖 */
interface WorkspaceLike {
  attachSession(sessionId: SessionId): Promise<void>;
}

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
}

/**
 * 同一个 QQ 会话里第 epoch 条 dsh 会话的 key。epoch 由绑定表分配，所以同一个 epoch
 * 永远派生出同一个 SessionId —— 重启后能 resume 回同一条，不需要额外映射。
 */
export function sessionKeyOf(
  appId: string,
  scope: "group" | "c2c",
  peerId: string,
  epoch: number,
): string {
  return `yashiro:${appId}:${scope}:${peerId}:${epoch}`;
}

export function sessionIdOf(key: string): SessionId {
  return createHash("sha256").update(key).digest("hex") as unknown as SessionId;
}

export class SessionManager {
  /** 只放内存里活着的 agent；SessionId 是它的唯一标识 */
  private readonly sessions = new Map<SessionId, SessionEntry>();
  /** sessionId → 会话身份：审批通道按 `request.agent.id` 反查卡片该发到哪儿 */
  private readonly targets = new Map<SessionId, ApprovalTarget>();
  /** 解析出来的 workspace：undefined = 还没找过，null = 找过但没有 */
  private workspaceEntity: WorkspaceLike | null | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly appId: string,
    private readonly cwd: string | undefined,
    private readonly logger: {
      info(message: string): void;
      debug(message: string): void;
    },
  ) {}

  /** 按 sessionId 找本插件的会话；不是本插件的会话返回 undefined */
  findTarget(sessionId: string): ApprovalTarget | undefined {
    return this.targets.get(sessionId as SessionId);
  }

  /**
   * `ctx.agents.create()` 不会自己查默认模型，必须由调用方把 agentOptions 传进去，
   * 否则 agent 没有模型路由，回合跑不起来（session 建了但一句话不回）。
   */
  private resolveAgentOptions(): AgentOptions | undefined {
    try {
      const service = this.ctx.get("agentDefaultModel") as
        | { currentSelection(): ModelSelection }
        | undefined;
      const selection = service?.currentSelection();
      if (!selection?.provider || !selection.model) return undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 只找一次，找不到就记住「没有」。
   * 只有 profile 挂了 workspace 域才有这个服务，没挂或目录未注册都返回 null。
   */
  private async resolveWorkspace(): Promise<WorkspaceLike | null> {
    if (this.workspaceEntity !== undefined) return this.workspaceEntity;
    this.workspaceEntity = null;

    const registry = this.ctx.get("workspaceRegistry") as
      | WorkspaceRegistryLike
      | undefined;
    if (registry === undefined || this.cwd === undefined) return null;
    try {
      const found = await registry.resolveByPath(this.cwd);
      if (found === undefined) {
        this.logger.debug(
          `[dsh-yashiro] 启动目录不是已注册的 workspace，跳过挂载：${this.cwd}`,
        );
        return null;
      }
      this.workspaceEntity = found;
      return found;
    } catch (err) {
      this.logger.info(
        `[dsh-yashiro] 查找 workspace 失败（不影响对话）：${describeError(err)}`,
      );
      return null;
    }
  }

  /**
   * 插件用 `ctx.agents.create()` 建的会话不会自动出现在 web 侧边栏里（那份记录只有
   * web 进程自己写），必须显式挂到 workspace 名下。
   *
   * 挂载幂等，而那份记录是整份覆盖写的、别的进程一写就可能把这条 id 抹掉，
   * 所以每条消息都补挂一次才能自愈。
   */
  private async attachToWorkspace(sessionId: SessionId): Promise<void> {
    const workspace = await this.resolveWorkspace();
    if (workspace === null) return;
    try {
      await workspace.attachSession(sessionId);
    } catch (err) {
      this.logger.info(
        `[dsh-yashiro] 挂载 workspace 失败（不影响对话）：${describeError(err)}`,
      );
    }
  }

  /**
   * 新建这个 QQ 会话的第 epoch 条 dsh 会话；epoch 由调用方从绑定表取，保证确定性派生。
   * 建不出来会抛错，调用方据此决定要不要落绑定 —— 先有会话再有绑定，不会留下悬空指针。
   */
  async create(
    scope: "group" | "c2c",
    peerId: string,
    epoch: number,
    setup: AgentSetup,
  ): Promise<Agent> {
    const sessionId = sessionIdOf(
      sessionKeyOf(this.appId, scope, peerId, epoch),
    );
    const agentOptions = this.resolveAgentOptions();
    const handle = await this.ctx.agents.create({
      sessionId,
      ...(this.cwd ? { meta: { cwd: this.cwd } } : {}),
      ...(agentOptions ? { agentOptions } : {}),
      setup,
    });
    this.remember(sessionId, handle, scope, peerId);
    await this.attachToWorkspace(sessionId);
    return handle.agent;
  }

  /**
   * 连到一条已经存在的会话；它只可能在磁盘上，因为在内存里没有。
   *
   * 连不上就返回 undefined（调用方回复「连不上」），**不会**退化成新建 ——
   * 否则会话文件被删掉之后，这里会悄悄给出一条空会话，看起来像切换成功了。
   */
  async select(
    scope: "group" | "c2c",
    peerId: string,
    sessionId: string,
    setup: AgentSetup,
  ): Promise<Agent | undefined> {
    const id = sessionId as SessionId;

    const cached = this.sessions.get(id);
    if (cached) {
      await this.attachToWorkspace(id);
      return cached.agent;
    }

    // 已经在 live registry 里（例如插件热重载后），复用即可 —— 但没有拆除权
    const live = this.ctx.agents.get(id);
    if (live) {
      this.remember(
        id,
        { agent: live, dispose: async () => {} },
        scope,
        peerId,
      );
      await this.attachToWorkspace(id);
      return live;
    }

    const agentOptions = this.resolveAgentOptions();
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: id,
        ...(this.cwd ? { meta: { cwd: this.cwd } } : {}),
        ...(agentOptions ? { agentOptions } : {}),
        setup,
      });
      this.remember(id, handle, scope, peerId);
      await this.attachToWorkspace(id);
      return handle.agent;
    } catch (err) {
      this.logger.info(
        `[dsh-yashiro] 会话连不上（不回退成新建）：${describeError(err)}`,
      );
      return undefined;
    }
  }

  private remember(
    sessionId: SessionId,
    handle: AgentHandle,
    scope: "group" | "c2c",
    peerId: string,
  ): void {
    this.sessions.set(sessionId, {
      agent: handle.agent,
      dispose: () => handle.dispose(),
    });
    this.targets.set(sessionId, { scope, peerId });
  }

  /** 拆除全部会话（插件卸载时调用） */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.targets.clear();
    await Promise.all(entries.map((e) => e.dispose().catch(() => {})));
  }
}
