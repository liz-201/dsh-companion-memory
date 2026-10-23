/**
 * 主动消息投递（任务书 §14.4、§14.5、§6.3）。
 *
 * outbox 是唯一出口：scheduler 只**入队**，这里才真正发送。这样做的原因很实际——
 * 进程崩溃、用户刚好又发来消息、提醒已经过期，这些都需要在「按下发送」的前一刻
 * 再判断一次，而不是在生成时就假定一切没变。
 *
 * 状态机（与 outbox 表一致）：
 *   pending → sending → sent / failed / unknown
 *   pending → cancelled（发送前复核不通过）
 * 硬规矩：
 *   · 平台明确拒绝（rejected）⇒ failed，按错误码决定是否还能再试；
 *   · 超时/断连（unknown）⇒ 保持 unknown，**绝不自动重发**；
 *   · 发送前复核 expectedInboundSeq：用户已经说话了就取消这条主动消息；
 *   · 每个回执都落库，回执不是「我们试过了」，而是「平台怎么说」。
 */
import type { Config } from '../config.js'
import type { DeliveryReceipt } from '../domain/types.js'
import type { Repositories } from '../storage/repositories.js'
import type { QqTransport } from '../adapters/qq-transport.js'
import type { Metrics } from '../runtime/metrics.js'

export type OutboxOutcome =
    | { id: string; status: 'sent'; receipt: DeliveryReceipt; chatId: string }
    | { id: string; status: 'failed'; receipt: DeliveryReceipt; chatId: string; retryable: boolean }
    | { id: string; status: 'unknown'; receipt: DeliveryReceipt; chatId: string }
    | { id: string; status: 'cancelled'; reason: string; chatId: string | null }

export interface OutboxWorkerOptions {
    config: Config
    repos: Repositories
    transport: QqTransport
    metrics: Metrics
    /** 会话 → 平台 chatId（`private:123` / `group:456`）。返回 null 表示这个会话不该外发。 */
    chatForConversation: (conversationId: string) => string | null
    now?: () => number
    limit?: number
}

/** 可重试的错误码：只认平台明确说过「稍后再试」的那几类。 */
const RETRYABLE_CODES = new Set([
    'rate_limited',
    'overload',
    'server_error',
    'network_error',
    'timeout',
])

function str(row: Record<string, unknown>, key: string): string | null {
    const value = row[key]
    return typeof value === 'string' ? value : null
}

function num(row: Record<string, unknown>, key: string): number | null {
    const value = row[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class OutboxWorker {
    private readonly options: OutboxWorkerOptions
    private readonly now: () => number
    private running = false

    constructor(options: OutboxWorkerOptions) {
        this.options = options
        this.now = options.now ?? (() => Date.now())
    }

    /**
     * 取一批待发消息并逐条投递。
     *
     * 返回的每一项都对应 outbox 里真实发生过的一次状态变化，供 scheduler 记账
     * 与 `/fish status` 展示；调用方不依赖它做业务判断。
     */
    async runOnce(nowMs: number = this.now()): Promise<OutboxOutcome[]> {
        const { repos, transport, metrics } = this.options
        // 重启后的自救：sending 一律降级 unknown，避免「可能已发」被当成失败重发。
        if (this.running) return []
        this.running = true
        try {
        const rows = repos.claimOutbox(nowMs, this.options.limit ?? 5)
        const outcomes: OutboxOutcome[] = []

        for (const row of rows) {
            const id = str(row, 'id')
            const conversationId = str(row, 'conversation_id')
            if (id === null || conversationId === null) continue
            const chatId = this.options.chatForConversation(conversationId)
            if (chatId === null) {
                repos.cancelOutbox(id, 'no_chat_target')
                outcomes.push({ id, status: 'cancelled', reason: 'no_chat_target', chatId: null })
                metrics.count('outbox.cancelled', 1)
                continue
            }

            const cancelled = this.recheck(row, conversationId, nowMs)
            if (cancelled !== null) {
                repos.cancelOutbox(id, cancelled)
                outcomes.push({ id, status: 'cancelled', reason: cancelled, chatId })
                metrics.count(`outbox.cancelled.${cancelled}`, 1)
                continue
            }

            const content = str(row, 'content') ?? ''
            if (content.trim().length === 0) {
                repos.cancelOutbox(id, 'empty_content')
                outcomes.push({ id, status: 'cancelled', reason: 'empty_content', chatId })
                continue
            }

            const startedAt = this.now()
            let receipt: DeliveryReceipt
            try {
                receipt = await transport.sendText(chatId, content)
            } catch (error) {
                // 传输层自身抛错 = 我们不知道平台有没有收到：按 unknown 处理，不重发。
                receipt = { kind: 'unknown', code: 'transport_threw', atMs: this.now() }
                metrics.degrade(`主动消息发送异常：${error instanceof Error ? error.message : String(error)}`)
            }
            metrics.span('', 'send', startedAt, this.now())
            repos.finishOutbox(id, receipt)

            const taskId = str(row, 'task_id')
            if (receipt.kind === 'accepted' && taskId !== null) {
                // 提醒发出后即完成；未确认的提醒不在这里改状态（它还需要用户确认）。
                const task = repos.dueTasks(nowMs, 100).find(item => str(item, 'id') === taskId)
                if (task !== undefined) repos.setTaskStatus(taskId, 'done')
            }

            if (receipt.kind === 'accepted') {
                outcomes.push({ id, status: 'sent', receipt, chatId })
                metrics.count('outbox.sent', 1)
            } else if (receipt.kind === 'rejected') {
                const code = receipt.code ?? 'unknown_reject'
                const attempts = num(row, 'attempts') ?? 0
                const retryable = RETRYABLE_CODES.has(code) && attempts < 2
                outcomes.push({ id, status: 'failed', receipt, chatId, retryable })
                metrics.count('outbox.failed', 1)
                if (retryable) {
                    // 回到 pending 让下一轮再试；attempts 已在 claim 时 +1。
                    repos.replanOutbox(id, nowMs + 60_000)
                }
            } else {
                outcomes.push({ id, status: 'unknown', receipt, chatId })
                metrics.count('outbox.unknown', 1)
                metrics.degrade('主动消息回执 unknown：可能已送达，不自动重发')
            }
        }

        return outcomes
        } finally { this.running = false }
    }

    /** 发送前复核（§14.4）。返回取消原因，null 表示可以发。 */
    private recheck(row: Record<string, unknown>, conversationId: string, nowMs: number): string | null {
        const { repos, config } = this.options
        const expected = num(row, 'expected_inbound_seq')
        if (expected !== null) {
            const latest = repos.latestInboundSeq(conversationId)
            if (latest > expected) return 'user_spoke_first'
        }

        const taskId = str(row, 'task_id')
        if (taskId !== null) {
            const task = repos.db.get<{ status: string; expires_at_ms: number | null }>('SELECT status, expires_at_ms FROM tasks WHERE id = ?', taskId)
            if (!task || task.status !== 'confirmed') return 'task_finished'
            if (task.expires_at_ms !== null && task.expires_at_ms <= nowMs) return 'task_expired'
        }
        const plannedAt = num(row, 'planned_at_ms') ?? nowMs
        // 过期兜底：超过一天的主动消息不再补发（陈旧问候不如不发）。
        if (nowMs - plannedAt > 24 * 60 * 60_000) return 'expired'

        if (taskId !== null) {
            const task = repos.dueTasks(nowMs, 100).find(item => str(item, 'id') === taskId)
            if (task === undefined) {
                // 提醒可能已经完成或被取消：只有确认过状态才取消。
                const pending = repos.pendingTasks(conversationId, 50).find(item => str(item, 'id') === taskId)
                if (pending === undefined) return 'task_finished'
            }
        }

        if (taskId === null && (repos.getSetting('proactive.enabled') ?? (config.proactive.enabled ? '1' : '0')) !== '1') return 'proactive_disabled'
        return null
    }
}
