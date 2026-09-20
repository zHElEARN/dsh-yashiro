/**
 * 会话管理：一个 QQ 会话（群 / 单聊）对应一条 dsh agent 会话。
 *
 * sessionKey 形如 `yashiro:${appId}:${scope}:${peerId}`，SessionId 由它做
 * SHA-256 确定性派生 —— 同一来源永远路由到同一条会话，进程重启后能 resume
 * 回来，不需要额外的映射表。
 *
 * 以后要做「多会话切换」时，只要往 sessionKey 里再拼一维（比如 topic 或
 * epoch），派生出来的 SessionId 自然就是另一条会话，这里不用改结构。
 */
import { createHash } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

import type { ApprovalTarget } from './approval.js'

/** 一条活跃会话：agent + 可选的拆除能力 */
interface SessionEntry {
  agent: Agent
  dispose: () => Promise<void>
}

/** workspace 域（@deepseek-ai/dsh-workspace）里我们用到的最小面 */
interface WorkspaceLike {
  attachSession(sessionId: SessionId): Promise<void>
}

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
}

export function sessionKeyOf(appId: string, scope: 'group' | 'c2c', peerId: string): string {
  return `yashiro:${appId}:${scope}:${peerId}`
}

export function sessionIdOf(key: string): SessionId {
  return createHash('sha256').update(key).digest('hex') as unknown as SessionId
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>()
  /** sessionId → 会话身份：审批通道按 `request.agent.id` 反查卡片该发到哪儿 */
  private readonly targets = new Map<SessionId, ApprovalTarget>()
  /** 解析出来的 workspace：undefined = 还没找过，null = 找过但没有 */
  private workspaceEntity: WorkspaceLike | null | undefined

  constructor(
    private readonly ctx: Context,
    private readonly appId: string,
    private readonly cwd: string | undefined,
    private readonly logger: { info(message: string): void; debug(message: string): void },
  ) {}

  /** 按 sessionId 找本插件的会话；不是本插件的会话返回 undefined */
  findTarget(sessionId: string): ApprovalTarget | undefined {
    return this.targets.get(sessionId as SessionId)
  }

  /**
   * 取这次的模型路由。
   *
   * 这一步不能省：`ctx.agents.create()` **不会**自己去查默认模型 ——
   * `dsh-agent-default-model` 的定位是「回答『新 agent 该用哪个模型』这个问题，
   * 由创建 agent 的入口来咨询它」。不传 agentOptions 的话，agent 就没有模型路由，
   * 回合根本跑不起来（表现就是：session 建了，但一句话都不回）。
   */
  private resolveAgentOptions(): AgentOptions | undefined {
    try {
      const service = this.ctx.get('agentDefaultModel') as
        | { currentSelection(): ModelSelection }
        | undefined
      const selection = service?.currentSelection()
      if (!selection?.provider || !selection.model) return undefined
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    } catch {
      return undefined
    }
  }

  /**
   * 找到当前启动目录对应的 workspace（只找一次，找不到就记住"没有"）。
   *
   * 只有 profile 挂了 workspace 域（web bundle，或单独一行 @deepseek-ai/dsh-workspace）
   * 才会有这个服务；没挂、或者启动目录不是已注册的 workspace，都返回 null。
   */
  private async resolveWorkspace(): Promise<WorkspaceLike | null> {
    if (this.workspaceEntity !== undefined) return this.workspaceEntity
    this.workspaceEntity = null

    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined || this.cwd === undefined) return null
    try {
      const found = await registry.resolveByPath(this.cwd)
      if (found === undefined) {
        this.logger.debug(`[dsh-yashiro] 启动目录不是已注册的 workspace，跳过挂载：${this.cwd}`)
        return null
      }
      this.workspaceEntity = found
      return found
    } catch (err) {
      this.logger.info(`[dsh-yashiro] 查找 workspace 失败（不影响对话）：${describe(err)}`)
      return null
    }
  }

  /**
   * 把这条会话挂到 workspace 名下。
   *
   * web 侧边栏渲染的是 workspace 记录里的 sessionIds，而那份记录只有 web 进程
   * 自己通过 API 建/派生会话时才会写入 —— 插件用 `ctx.agents.create()` 建出来的
   * 会话不挂上去，就永远不会出现在侧边栏里。
   *
   * 挂载是幂等的：id 已在记录里时域内部直接空操作、不写盘。所以这里每条消息都
   * 调一次 —— 侧边栏那份记录是整份文档覆盖写的，别的进程一写就可能把这条 id
   * 抹掉，每次 @ 都补一下才能自愈。
   */
  private async attachToWorkspace(sessionId: SessionId): Promise<void> {
    const workspace = await this.resolveWorkspace()
    if (workspace === null) return
    try {
      await workspace.attachSession(sessionId)
    } catch (err) {
      this.logger.info(`[dsh-yashiro] 挂载 workspace 失败（不影响对话）：${describe(err)}`)
    }
  }

  /** 拿到（或建立）这个 QQ 会话对应的 agent */
  async getOrCreate(
    scope: 'group' | 'c2c',
    peerId: string,
    setup: AgentSetup,
  ): Promise<Agent> {
    const key = sessionKeyOf(this.appId, scope, peerId)
    const sessionId = sessionIdOf(key)

    const cached = this.sessions.get(key)
    if (cached) {
      await this.attachToWorkspace(sessionId)
      return cached.agent
    }

    const agentOptions = this.resolveAgentOptions()

    // 1) 已经在 live registry 里（例如插件热重载后），直接复用 —— 但没有拆除权
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      this.sessions.set(key, { agent: live, dispose: async () => {} })
      this.targets.set(sessionId, { sessionKey: key, scope, peerId })
      await this.attachToWorkspace(sessionId)
      return live
    }

    // 2) 磁盘上有历史会话 → resume
    let handle: AgentHandle | undefined
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(this.cwd ? { meta: { cwd: this.cwd } } : {}),
        ...(agentOptions ? { agentOptions } : {}),
        setup,
      })
    } catch {
      handle = undefined
    }

    // 3) 全新会话
    if (!handle) {
      handle = await this.ctx.agents.create({
        sessionId,
        ...(this.cwd ? { meta: { cwd: this.cwd } } : {}),
        ...(agentOptions ? { agentOptions } : {}),
        setup,
      })
    }

    const created = handle
    this.sessions.set(key, { agent: created.agent, dispose: () => created.dispose() })
    this.targets.set(sessionId, { sessionKey: key, scope, peerId })
    await this.attachToWorkspace(sessionId)
    return created.agent
  }

  /** 拆除全部会话（插件卸载时调用） */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    this.targets.clear()
    await Promise.all(entries.map((e) => e.dispose().catch(() => {})))
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}
