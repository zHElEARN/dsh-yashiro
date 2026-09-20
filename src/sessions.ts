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

/** 一条活跃会话：agent + 可选的拆除能力 */
interface SessionEntry {
  agent: Agent
  dispose: () => Promise<void>
}

export function sessionKeyOf(appId: string, scope: 'group' | 'c2c', peerId: string): string {
  return `yashiro:${appId}:${scope}:${peerId}`
}

export function sessionIdOf(key: string): SessionId {
  return createHash('sha256').update(key).digest('hex') as unknown as SessionId
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>()

  constructor(
    private readonly ctx: Context,
    private readonly appId: string,
    private readonly cwd: string | undefined,
  ) {}

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

  /** 拿到（或建立）这个 QQ 会话对应的 agent */
  async getOrCreate(
    scope: 'group' | 'c2c',
    peerId: string,
    setup: AgentSetup,
  ): Promise<Agent> {
    const key = sessionKeyOf(this.appId, scope, peerId)

    const cached = this.sessions.get(key)
    if (cached) return cached.agent

    const sessionId = sessionIdOf(key)
    const agentOptions = this.resolveAgentOptions()

    // 1) 已经在 live registry 里（例如插件热重载后），直接复用 —— 但没有拆除权
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      this.sessions.set(key, { agent: live, dispose: async () => {} })
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
    return created.agent
  }

  /** 拆除全部会话（插件卸载时调用） */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map((e) => e.dispose().catch(() => {})))
  }
}
