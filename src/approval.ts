/**
 * 审批通道：把 dsh 的 `approval/request` 桥接到 QQ 群里的两个按钮。
 *
 * 链路：agent 在工作区外动手 → 沙箱拒绝 → 模型按工具说明用 `sandbox_permissions`
 * + `justification` 重试一次 → dsh-tools 走 `approval.request()` → `approval/request`
 * waterfall → 这里。按钮点击以 `INTERACTION_CREATE` 从 WebSocket 推回来，不需要
 * 回调服务器，也不需要开通 interaction 之外的 intent。
 *
 * 语义对齐 dsh-user-approval（结构化契约，不硬依赖那个包）：
 * - outcome 是闭合集合 allowed-once / rejected / cancelled / unavailable，只有
 *   allowed-once 放行；
 * - 卡片发不出去就返回 unavailable（fail closed）；
 * - request.signal abort → cancelled；插件卸载 → 全部 cancelled。
 *
 * 每个会话同时只挂一个 pending：审批会把那一轮阻塞住，正常情况下不会并发。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs'

// ── 最小契约（对齐 dsh-user-approval，避免硬依赖） ──

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** session log 里 tool/call 事件的最小结构（回显被 gate 的命令用） */
interface ApprovalSessionEvent {
  type: string
  data?: { callId?: unknown; arguments?: unknown }
}

/**
 * session log 的最小读取面。
 *
 * dsh rc.2 的 Session **没有 `events` 数组**，只有 `eventAt(seq)` 和 `get seq()`；
 * 腾讯官方插件的契约里写的是 `session.events`。两种都兼容，读不到就回退成
 * "没有命令可回显"，绝不让回显这一步把审批本身搞挂。
 */
interface ApprovalSessionLike {
  /** 事件总数（rc.2 就是日志偏移量） */
  seq?: number
  /** 按下标取事件（rc.2） */
  eventAt?(seq: number): ApprovalSessionEvent | undefined
  /** 整份事件数组（官方插件的契约形状） */
  events?: ApprovalSessionEvent[]
}

export interface ApprovalRequest {
  agent: { id: string; session: ApprovalSessionLike }
  toolName: string
  /** 关联的 tool/call 事件 id：审批请求本身不带命令行，靠它回日志里找 */
  callId?: string
  /** 模型写的理由（沙箱升级时就是那行 justification） */
  reason?: string
  signal?: AbortSignal
}

/** 一条 QQ 会话的身份：发卡片要知道发到哪，pending 以 sessionKey 为键 */
export interface ApprovalTarget {
  sessionKey: string
  scope: 'group' | 'c2c'
  peerId: string
}

/** 卡片发不出去 / 超时提示用的发送口（gateway 提供） */
export type ApprovalSender = (
  target: ApprovalTarget,
  text: string,
  keyboard?: InlineKeyboard,
) => Promise<unknown>

export interface ApprovalLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

/** 只需要用到 cordis 的两个能力，便于单测时替身 */
export interface ApprovalContext {
  get(name: string): unknown
  on(event: string, handler: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): void
}

// ── button_data 编解码 ──

interface ApprovalButtonData {
  /** 顶层判别字段：QQ 只有一个 interaction 入口，靠它路由到对应通道 */
  t: 'approval'
  d: 'allow' | 'deny'
}

export function encodeApprovalButton(decision: 'allow' | 'deny'): string {
  const data: ApprovalButtonData = { t: 'approval', d: decision }
  return JSON.stringify(data)
}

export function decodeApprovalButton(raw: string): ApprovalButtonData | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalButtonData>
    if (parsed !== null && typeof parsed === 'object' && parsed.t === 'approval') {
      if (parsed.d === 'allow' || parsed.d === 'deny') return { t: 'approval', d: parsed.d }
    }
  } catch {
    /* 非 JSON，不是我们的按钮 */
  }
  return undefined
}

// ── 渲染 ──

/** 命令回显的截断长度 */
const COMMAND_CLIP = 500

/**
 * 从 session log 按 callId 倒着找回被 gate 的命令（对齐官方 commandOf 的语义）。
 * 读不到事件或匹配不上都返回 undefined —— 回显只是锦上添花。
 */
export function commandOf(request: ApprovalRequest): string | undefined {
  if (request.callId === undefined) return undefined
  const session = request.agent.session
  const events = Array.isArray(session.events) ? session.events : undefined
  const last = events !== undefined
    ? events.length - 1
    : typeof session.seq === 'number'
      ? session.seq - 1
      : -1

  for (let i = last; i >= 0; i -= 1) {
    const event = events !== undefined ? events[i] : session.eventAt?.(i)
    if (event?.type !== 'tool/call') continue
    const data = event.data
    if (String(data?.callId) !== String(request.callId)) continue
    const raw = data?.arguments
    if (typeof raw !== 'string') return undefined
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = (parsed as { command?: unknown }).command
        if (typeof command === 'string') return command
      }
    } catch {
      /* 非 JSON，回退到原始字符串 */
    }
    return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`
  }
  return undefined
}

/** 把审批请求渲染成 QQ markdown 卡片（timeoutMs 是毫秒，和通道里的单位一致） */
export function buildApprovalText(
  request: ApprovalRequest,
  command: string | undefined,
  timeoutMs: number,
): string {
  const lines = ['🔐 **执行审批**', '', `🔧 工具：${request.toolName}`]
  if (command) lines.push('', '```', command, '```')
  if (request.reason) lines.push('', `📝 ${request.reason}`)
  lines.push('', `> 👇 点击下方按钮决定是否允许（${Math.round(timeoutMs / 60_000)} 分钟无人处理按拒绝处理）`)
  return lines.join('\n')
}

type ButtonPermission = InlineKeyboard['content']['rows'][number]['buttons'][number]['action']['permission']

/**
 * 构建审批键盘：允许一次 / 拒绝。
 *
 * `group_id` 相同 → 点过一个之后另一个变灰；`click_limit: 1` → 每个按钮只能点一次。
 * approvers 非空时把按钮限给这些人（permission.type=0 + specify_user_ids，平台侧
 * 只让名单内的人可点），点回来还会再校验一次。
 */
export function buildApprovalKeyboard(approvers: readonly string[]): InlineKeyboard {
  const permission: ButtonPermission =
    approvers.length > 0
      ? ({ type: 0, specify_user_ids: [...approvers] } as ButtonPermission)
      : ({ type: 2 } as ButtonPermission)

  const button = (
    id: string,
    label: string,
    visitedLabel: string,
    style: number,
    decision: 'allow' | 'deny',
  ) => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: { type: 1, permission, click_limit: 1, data: encodeApprovalButton(decision) },
    group_id: 'approval',
  })

  return {
    content: {
      rows: [
        {
          buttons: [
            button('approval-allow', '✅ 允许一次', '✓ 已允许', 1, 'allow'),
            button('approval-deny', '❌ 拒绝', '✓ 已拒绝', 0, 'deny'),
          ],
        },
      ],
    },
  }
}

// ── 通道 ──

interface PendingApproval {
  target: ApprovalTarget
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 300_000

export interface ApprovalChannelDeps {
  /** 本插件启动时的 appId（sessionKey 由它派生） */
  appId: string
  /** 谁能点按钮；空数组 = 群里任何人都能点。缺省按空处理 */
  approvers?: readonly string[]
  /** 多久无人处理按拒绝收场（毫秒）。缺省 5 分钟 */
  timeoutMs?: number
  send: ApprovalSender
  /** sessionId → 本插件的会话身份；不是本插件的会话返回 undefined */
  findTarget(sessionId: string): ApprovalTarget | undefined
  logger: ApprovalLogger
}

export class ApprovalChannel {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly approvers: readonly string[]
  private readonly timeoutMs: number

  constructor(private readonly deps: ApprovalChannelDeps) {
    // profile 层是整体替换 config 的，缺省字段在这里兜底，别让 undefined 落到渲染路径上
    this.approvers = deps.approvers ?? []
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 注册 approval/request waterfall 应答者；没有 approval 服务时优雅停用 */
  install(ctx: ApprovalContext): void {
    let hasApproval = false
    try {
      hasApproval = ctx.get('approval') !== undefined
    } catch {
      hasApproval = false
    }
    if (!hasApproval) {
      this.deps.logger.debug('[dsh-yashiro] 没有 approval 服务，QQ 审批通道停用')
      return
    }
    ctx.on(
      'approval/request',
      (request: unknown, next: unknown) =>
        this.route(request as ApprovalRequest, next as () => Promise<ApprovalOutcome>),
      { prepend: true },
    )
    this.deps.logger.info(
      `[dsh-yashiro] QQ 审批通道已挂载（可点的人=${this.approvers.length === 0 ? '群里任何人' : this.approvers.join('、')}，超时 ${Math.round(this.timeoutMs / 1000)}s）`,
    )
  }

  /**
   * 按钮点击：返回要回给平台的 ack code（0 成功 / 4 没权限），
   * undefined = 不是本通道的按钮，交给别的通道、由调用方回 3（重复操作）。
   */
  handleInteraction(event: InteractionEvent): number | undefined {
    const raw = event.data?.resolved?.button_data
    if (raw === undefined) return undefined
    const button = decodeApprovalButton(raw)
    if (button === undefined) return undefined

    const scope: 'group' | 'c2c' = event.scene === 'group' ? 'group' : 'c2c'
    const peerId = scope === 'group' ? (event.group_openid ?? '') : (event.user_openid ?? '')
    if (peerId === '') return undefined
    const sessionKey = `yashiro:${this.deps.appId}:${scope}:${peerId}`
    const entry = this.pending.get(sessionKey)
    if (entry === undefined) return undefined

    const clicker = scope === 'group' ? (event.group_member_openid ?? event.user_openid) : event.user_openid
    if (this.approvers.length > 0 && !this.approvers.includes(clicker ?? '')) {
      this.deps.logger.warn(`[dsh-yashiro] 审批按钮被未授权的人点击：${clicker ?? '(未知)'}`)
      return 4
    }

    this.deps.logger.info(
      `[dsh-yashiro] 审批${button.d === 'allow' ? '允许' : '拒绝'}：${entry.target.scope} ${entry.target.peerId}`,
    )
    this.settle(sessionKey, button.d === 'allow' ? 'allowed-once' : 'rejected')
    return 0
  }

  /** 取消全部 pending（插件卸载时调用，避免 Promise 悬挂） */
  cancelAll(): void {
    for (const key of [...this.pending.keys()]) this.settle(key, 'cancelled')
  }

  /** 不是本插件的会话 → 交给链上其他应答者（web / tui 可以共存） */
  private async route(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const target = this.deps.findTarget(request.agent.id)
    if (target === undefined) return next()
    return this.park(target, request)
  }

  private async park(target: ApprovalTarget, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const key = target.sessionKey
    if (request.signal?.aborted) return 'cancelled'
    if (this.pending.has(key)) {
      this.deps.logger.warn(`[dsh-yashiro] 该会话已有待审批请求，这一条按不可用处理：${key}`)
      return 'unavailable'
    }

    try {
      await this.deps.send(
        target,
        buildApprovalText(request, commandOf(request), this.timeoutMs),
        buildApprovalKeyboard(this.approvers),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.logger.error(`[dsh-yashiro] 审批卡片发送失败（按不可用处理）：${message}`)
      return 'unavailable'
    }

    return await new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = {
        target,
        resolve,
        timer: setTimeout(() => {
          this.deps.logger.warn(`[dsh-yashiro] 审批超时未处理，按拒绝收场：${key}`)
          this.settle(key, 'rejected')
          void this.notifyTimeout(target)
        }, this.timeoutMs),
      }
      if (request.signal !== undefined) {
        entry.signal = request.signal
        entry.onAbort = () => this.settle(key, 'cancelled')
        request.signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.pending.set(key, entry)
      this.deps.logger.info(`[dsh-yashiro] 审批卡片已发到 QQ，等待点击：${key}`)
    })
  }

  private settle(key: string, outcome: ApprovalOutcome): void {
    const entry = this.pending.get(key)
    if (entry === undefined) return
    this.pending.delete(key)
    clearTimeout(entry.timer)
    if (entry.onAbort !== undefined && entry.signal !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(outcome)
  }

  private async notifyTimeout(target: ApprovalTarget): Promise<void> {
    try {
      await this.deps.send(
        target,
        `⏱ ${Math.round(this.timeoutMs / 60_000)} 分钟没人处理，这条审批已按**拒绝**处理。`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.logger.warn(`[dsh-yashiro] 审批超时提示发送失败：${message}`)
    }
  }
}
