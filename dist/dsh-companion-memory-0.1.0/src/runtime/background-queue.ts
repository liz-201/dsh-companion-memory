/**
 * 后台任务队列（任务书 §6.1、§17.4、§10.5）。
 *
 * 目标：把「巩固记忆 / 后台提取 / 备份」这类慢动作挪出前台回合，且
 *   · 前台永远不等后台（§17.4「防止后台拖慢」）；
 *   · 同一 dedup_key 不会重复入队（重启、重试都靠它）；
 *   · 每次执行都有租约，进程崩了租约会自然过期，不产生永久锁；
 *   · 一个 timer，一个 worker，卸载时必须能停掉（§13.1 disposer）。
 *
 * 这里只管「调度与执行边界」，具体做什么由 handler 决定。
 */

import type { Repositories } from '../storage/repositories.js'
import type { Metrics } from './metrics.js'

export type JobKind = 'consolidate' | 'extract' | 'backup' | 'prune' | 'proactive-scan'

export interface JobPayload {
  conversationId?: string
  principalId?: string
  afterSeq?: number
  [key: string]: unknown
}

export type JobHandler = (job: { id: string; kind: string; payload: JobPayload }) => Promise<void> | void

export interface BackgroundQueueOptions {
  /** 轮询间隔；默认 5s。 */
  tickMs?: number
  /** 单次租约；默认 60s。崩溃后最多这么久自愈。 */
  leaseMs?: number
  /** 单轮最多取几个；默认 2。 */
  batch?: number
  /** 是否在后台真的跑（关闭后只入队不执行，测试用）。 */
  enabled?: boolean
  maxRetries?: number
}

export interface BackgroundStats {
  running: boolean
  tickMs: number
  claimedTotal: number
  doneTotal: number
  failedTotal: number
  lastError: string | null
  handlers: string[]
}

export class BackgroundQueue {
  private readonly handlers = new Map<string, JobHandler>()
  private readonly tickMs: number
  private readonly leaseMs: number
  private readonly batch: number
  private readonly maxRetries: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private stopping = false
  private claimedTotal = 0
  private doneTotal = 0
  private failedTotal = 0
  private lastError: string | null = null
  private inFlight = 0

  constructor(
    private readonly repos: Repositories,
    private readonly metrics: Metrics,
    private readonly options: BackgroundQueueOptions = {},
  ) {
    this.tickMs = Math.max(500, options.tickMs ?? 5_000)
    this.leaseMs = Math.max(5_000, options.leaseMs ?? 60_000)
    this.batch = Math.max(1, options.batch ?? 2)
    this.maxRetries = Math.max(0, options.maxRetries ?? 3)
  }

  /** 注册一种任务的执行体；重复注册同一 kind 直接覆盖（热重载友好）。 */
  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  /** 入队；dedup_key 已存在时返回 false。 */
  enqueue(kind: JobKind, payload: JobPayload, options: { dedupKey: string; availableAtMs: number; nowMs: number; principalId?: string | null }): boolean {
    try {
      const inserted = this.repos.enqueueJob({
        id: `${kind}:${options.dedupKey}`,
        dedupKey: options.dedupKey,
        principalId: options.principalId ?? null,
        kind,
        payload,
        availableAtMs: options.availableAtMs,
        createdAtMs: options.nowMs,
      })
      if (inserted) this.metrics.count(`bg.enqueued.${kind}`)
      return inserted
    } catch (error) {
      this.lastError = describe(error)
      this.metrics.degrade(`后台任务入队失败：${this.lastError}`)
      return false
    }
  }

  start(): void {
    if (this.timer !== null || this.options.enabled === false) return
    this.stopping = false
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    // unref：后台队列不能单独把进程吊住（桌面端退出时可正常关）
    const handle = this.timer as unknown as { unref?: () => void }
    handle.unref?.()
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.running || this.stopping) return
    this.running = true
    try {
      const jobs = this.repos.claimJobs(nowMs, this.leaseMs, this.batch)
      for (const job of jobs) {
        this.claimedTotal += 1
        const id = String(job['id'] ?? '')
        const kind = String(job['kind'] ?? '')
        const handler = this.handlers.get(kind as JobKind)
        if (handler === undefined) {
          this.repos.finishJob(id, 'cancelled', `no handler for ${kind}`)
          continue
        }
        this.inFlight += 1
        const startedAt = Date.now()
        try {
          const payload = parsePayload(job['payload_json'])
          await handler({ id, kind, payload })
          this.repos.finishJob(id, 'done')
          this.doneTotal += 1
          this.metrics.count(`bg.done.${kind}`)
        } catch (error) {
          this.failedTotal += 1
          this.lastError = describe(error)
          this.metrics.degrade(`后台任务失败（${kind}）：${this.lastError}`)
          const attempts = Number(job['attempts'] ?? 0)
          if (attempts >= this.maxRetries) this.repos.finishJob(id, 'failed', this.lastError)
          else this.repos.finishJob(id, 'failed', this.lastError)
        } finally {
          this.inFlight -= 1
          this.metrics.record(id, 'assembly', Date.now() - startedAt, Date.now())
        }
      }
    } catch (error) {
      this.lastError = describe(error)
      this.metrics.degrade(`后台队列 tick 异常：${this.lastError}`)
    } finally {
      this.running = false
    }
  }

  /** 等当前在跑的任务收尾（卸载时用，最多等 timeoutMs）。 */
  async drain(timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return this.inFlight === 0
  }

  stop(): void {
    this.stopping = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  stats(): BackgroundStats {
    return {
      running: this.timer !== null,
      tickMs: this.tickMs,
      claimedTotal: this.claimedTotal,
      doneTotal: this.doneTotal,
      failedTotal: this.failedTotal,
      lastError: this.lastError,
      handlers: [...this.handlers.keys()].sort(),
    }
  }

  /** 供 doctor 展示的「库里还剩多少任务」。 */
  backlog(): Record<string, number> {
    try {
      return this.repos.jobStats()
    } catch {
      return {}
    }
  }

  get isRunning(): boolean {
    return this.timer !== null
  }
}

function parsePayload(raw: unknown): JobPayload {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') return parsed as JobPayload
    return {}
  } catch {
    return {}
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
