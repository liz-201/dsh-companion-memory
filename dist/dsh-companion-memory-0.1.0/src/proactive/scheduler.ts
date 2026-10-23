/**
 * 主动消息调度（任务书 §14.2、§14.4、§13.1 disposer）。
 *
 * 一个 timer、一个循环，扫描所有「已启用陪伴」的会话：
 *   硬闸门 → 候选 → （必要时）一次模型调用生成正文 → 写入 outbox。
 * 生成的正文**不直接发送**，统一交给 outbox-worker，这样崩溃/重启/用户抢话
 * 都能在发送前再复核一次。
 *
 * 三条硬约束：
 *   · 大多数扫描不调模型（§14.2）：只有真的选出了候选、且该候选不是「纯提醒播报」
 *     时才生成；提醒文本直接用任务内容，不再花一次调用。
 *   · 每次扫描最多为 maxGenerationCallsPerCandidate 个候选调用模型（默认 1）。
 *   · stop() 之后不再有新的 tick；已入队 outbox 的消息仍由 worker 按需处理。
 */
import type { Config } from '../config.js'
import type { Repositories } from '../storage/repositories.js'
import type { Metrics } from '../runtime/metrics.js'
import { buildCandidates, startOfDayMs, type Candidate } from './candidate-builder.js'

export interface SchedulerConversation {
    conversationId: string
    principalId: string
    /** 关系状态，用于排序；缺省按中性处理。 */
    grievance?: number
    affection?: number
    unresolvedConflict?: boolean
}

export interface SchedulerOptions {
    config: Config
    repos: Repositories
    metrics: Metrics
    /** 列出应当被扫描的会话；由适配层根据绑定与启用状态给出。 */
    listConversations: () => SchedulerConversation[]
    /** 生成一条主动消息的正文；返回 null 表示这次放弃，不写 outbox。 */
    generate: (input: { candidate: Candidate; conversation: SchedulerConversation }) => Promise<string | null>
    /** 主回合是否在跑（避免插队）。 */
    mainTurnInFlight?: (conversationId: string) => boolean
    now?: () => number
    log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

export interface SchedulerScanResult {
    scanned: number
    gatesBlocked: number
    candidates: number
    generated: number
    enqueued: number
    skipped: { conversationId: string; reason: string }[]
}

function hashText(text: string): string {
    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < text.length; index += 1) {
        hash ^= BigInt(text.charCodeAt(index))
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }
    return hash.toString(36)
}

function str(row: Record<string, unknown>, key: string): string | null {
    const value = row[key]
    return typeof value === 'string' ? value : null
}

function num(row: Record<string, unknown>, key: string): number | null {
    const value = row[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class ProactiveScheduler {
    private readonly options: SchedulerOptions
    private readonly now: () => number
    private timer: ReturnType<typeof setInterval> | null = null
    private scanning = false

    constructor(options: SchedulerOptions) {
        this.options = options
        this.now = options.now ?? (() => Date.now())
    }

    get running(): boolean {
        return this.timer !== null
    }

    /** 启动周期扫描；重复调用不会产生第二个 timer（热重载安全）。 */
    start(): void {
        if (this.timer !== null) return
        const intervalMs = Math.max(60_000, this.options.config.proactive.checkMinutes * 60_000)
        this.timer = setInterval(() => {
            void this.scan().catch(error => {
                this.options.log?.('warn', `主动扫描失败：${error instanceof Error ? error.message : String(error)}`)
            })
        }, intervalMs)
        // 不让定时器把进程钉住：卸载/退出时能自然结束。
        if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
            (this.timer as { unref: () => void }).unref()
        }
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    /** 单次扫描。测试直接调它，不依赖真实时间。 */
    async scan(nowMs: number = this.now()): Promise<SchedulerScanResult> {
        const { config, metrics, log } = this.options
        const result: SchedulerScanResult = {
            scanned: 0,
            gatesBlocked: 0,
            candidates: 0,
            generated: 0,
            enqueued: 0,
            skipped: [],
        }
        if (this.scanning) return result
        this.scanning = true

        try {
            if (!config.proactive.enabled) {
                result.skipped.push({ conversationId: '*', reason: 'proactive-disabled' })
                return result
            }

            const conversations = this.options.listConversations()
            for (const conversation of conversations) {
                result.scanned += 1
                try {
                    await this.scanOne(conversation, nowMs, result)
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    result.skipped.push({ conversationId: conversation.conversationId, reason: `error:${message}` })
                    metrics.degrade(`主动扫描失败：${message}`)
                    log?.('warn', `主动扫描会话失败 ${conversation.conversationId}: ${message}`)
                }
            }
            return result
        } finally {
            this.scanning = false
        }
    }

    private async scanOne(
        conversation: SchedulerConversation,
        nowMs: number,
        result: SchedulerScanResult,
    ): Promise<void> {
        const { config, repos, metrics, log } = this.options
        void repos
        const conversationId = conversation.conversationId
        const last = repos.lastOutboxForConversation(conversationId)
        const lastPlanned = last === undefined ? undefined : num(last, 'planned_at_ms') ?? undefined
        const lastStatus = last === undefined ? undefined : str(last, 'status')
        // 只有「已经发出去过」的消息才计入冷却；被取消的不算。
        const lastProactiveAtMs = lastPlanned !== undefined && (lastStatus === 'sent' || lastStatus === 'unknown')
            ? lastPlanned
            : undefined

        const built = buildCandidates({
            config,
            repos,
            conversationId,
            principalId: conversation.principalId,
            nowMs,
            mainTurnInFlight: this.options.mainTurnInFlight?.(conversationId) ?? false,
            lastProactiveAtMs,
            grievance: conversation.grievance,
            affection: conversation.affection,
            unresolvedConflict: conversation.unresolvedConflict,
        })

        if (!built.gate.ok) {
            result.gatesBlocked += 1
            result.skipped.push({ conversationId, reason: built.gate.blocked.join(',') })
            return
        }
        result.candidates += built.candidates.length
        if (built.selected === null) {
            result.skipped.push({ conversationId, reason: 'no-candidate' })
            return
        }

        const candidate = built.selected
        const budget = Math.max(0, config.proactive.maxGenerationCallsPerCandidate)
        if (budget === 0) {
            result.skipped.push({ conversationId, reason: 'generation-budget-zero' })
            return
        }

        let content: string | null
        if (candidate.kind === 'reminder') {
            // 提醒是明确约定：不靠模型复述，避免被性格改写成不准确的说法（§14.5）。
            content = `提醒你一件事：${candidate.topic}`
        } else {
            content = await this.safeGenerate(candidate, conversation)
            result.generated += 1
        }
        if (content === null || content.trim().length === 0) {
            result.skipped.push({ conversationId, reason: 'generation-empty' })
            return
        }

        const text = content.trim().slice(0, 1000)
        const outboxId = `ob_${hashText(`${candidate.key}:${nowMs}`)}`
        const enqueued = repos.enqueueOutbox({
            id: outboxId,
            conversationId,
            turnId: null,
            candidateKey: candidate.key,
            taskId: candidate.taskId,
            content: text,
            contentHash: hashText(text),
            plannedAtMs: nowMs,
            expectedInboundSeq: repos.latestInboundSeq(conversationId),
        })
        if (enqueued.inserted) {
            result.enqueued += 1
            metrics.count('proactive.enqueued', 1)
            repos.audit({
                principalId: conversation.principalId,
                kind: 'proactive-enqueued',
                entityId: outboxId,
                payload: { candidate: candidate.key, kind: candidate.kind, reasons: candidate.reasons },
                createdAtMs: nowMs,
            })
        } else {
            result.skipped.push({ conversationId, reason: 'duplicate-candidate' })
        }

        // 日限额统计用：扫描时顺带算一次，便于日志核对（不写入）。
        const sentToday = repos.countOutboxSince(conversationId, startOfDayMs(nowMs, config.proactive.timezone))
        log?.('debug', `主动扫描 ${conversationId}: candidate=${candidate.kind} 今日=${sentToday}`)
    }

    private async safeGenerate(
        candidate: Candidate,
        conversation: SchedulerConversation,
    ): Promise<string | null> {
        try {
            return await this.options.generate({ candidate, conversation })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.options.metrics.degrade(`主动生成失败：${message}`)
            this.options.log?.('warn', `主动生成失败：${message}`)
            return null
        }
    }
}
