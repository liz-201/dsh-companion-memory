/**
 * 观测与计时（任务书 §17.1–§17.5）。
 *
 * 只做「记录 + 汇总」，不做任何决策。计时点按 §17.2 定义：
 *   assembly（装配）→ retrieval（检索）→ queue-wait（排队）→
 *   provider-first-token（首个分片）→ say-close（正文收尾）→ send（送达）
 *
 * 延迟目标（§17.1）：
 *   装配 p95 ≤ 50ms；正文首字 p95 ≤ 1.2s；正文完整 p95 ≤ 3s；发送 p95 ≤ 1s。
 * 这里**不宣称**达标，只负责把实测值算出来给 bench/doctor 报告。
 */

export type Phase =
  | 'assembly'
  | 'retrieval'
  | 'queue-wait'
  | 'provider-first-token'
  | 'say-close'
  | 'evt-apply'
  | 'send'
  | 'total'

export const PHASES: readonly Phase[] = [
  'assembly',
  'retrieval',
  'queue-wait',
  'provider-first-token',
  'say-close',
  'evt-apply',
  'send',
  'total',
]

/** §17.1 的验收目标；报告里逐项对比，达不到就如实写「未达标」。 */
export const LATENCY_TARGETS_MS: Readonly<Record<Phase, number>> = {
  assembly: 50,
  retrieval: 50,
  'queue-wait': 250,
  'provider-first-token': 1200,
  'say-close': 3000,
  'evt-apply': 30,
  send: 1000,
  total: 4000,
}

export interface Sample {
  turnId: string
  phase: Phase
  ms: number
  atMs: number
}

export interface PhaseStat {
  phase: Phase
  count: number
  p50: number
  p95: number
  max: number
  targetMs: number
  met: boolean
}

export interface MetricsSnapshot {
  stats: PhaseStat[]
  counters: Record<string, number>
  degraded: string[]
  samplesKept: number
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

export class Metrics {
  private readonly samples: Sample[] = []
  private readonly counters = new Map<string, number>()
  private readonly degraded = new Set<string>()
  private readonly limit: number

  /** cap 防止长跑进程无限增长；超出后丢最旧的样本（计数器不受影响）。 */
  constructor(limit = 5000) {
    this.limit = Math.max(50, limit)
  }

  record(turnId: string, phase: Phase, ms: number, atMs: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.samples.push({ turnId, phase, ms, atMs })
    if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit)
  }

  /** 用一对时间戳记录一段耗时；缺任一端就跳过（不把未知当 0）。 */
  span(turnId: string, phase: Phase, startedAtMs: number | undefined, endedAtMs: number): void {
    if (startedAtMs === undefined) return
    this.record(turnId, phase, endedAtMs - startedAtMs, endedAtMs)
  }

  count(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta)
  }

  /** 降级原因去重记录，doctor 与 /fish status 直接展示。 */
  degrade(reason: string): void {
    this.degraded.add(reason)
  }

  stats(): PhaseStat[] {
    return PHASES.map(phase => {
      const values = this.samples.filter(s => s.phase === phase).map(s => s.ms).sort((a, b) => a - b)
      return {
        phase,
        count: values.length,
        p50: Math.round(percentile(values, 0.5)),
        p95: Math.round(percentile(values, 0.95)),
        max: Math.round(values.length === 0 ? 0 : (values[values.length - 1] ?? 0)),
        targetMs: LATENCY_TARGETS_MS[phase],
        met: values.length > 0 && percentile(values, 0.95) <= LATENCY_TARGETS_MS[phase],
      }
    })
  }

  snapshot(): MetricsSnapshot {
    return {
      stats: this.stats(),
      counters: Object.fromEntries(this.counters),
      degraded: [...this.degraded].sort(),
      samplesKept: this.samples.length,
    }
  }

  /** 一行人类可读摘要，供日志与 /fish status。 */
  summary(): string {
    const stats = this.stats().filter(s => s.count > 0)
    if (stats.length === 0) return '暂无计时样本'
    return stats
      .map(s => `${s.phase} p95=${s.p95}ms/${s.targetMs}ms${s.met ? '' : '(未达标)'}`)
      .join(' · ')
  }

  clear(): void {
    this.samples.length = 0
  }
}

/**
 * 简单的一次性秒表：调用方 start()，phase() 记录中间点。
 * 不依赖 Date.now 的隐式调用——clock 由参数传入，测试可注入固定时钟。
 */
export class TurnStopwatch {
  private readonly marks: { phase: Phase; atMs: number }[] = []

  private readonly start: number

  constructor(
    readonly turnId: string,
    private readonly metrics: Metrics,
    private nowMs: number,
  ) {
    this.start = nowMs
  }

  tick(nowMs: number): void {
    this.nowMs = nowMs
  }

  mark(phase: Phase, nowMs: number): void {
    this.marks.push({ phase, atMs: nowMs })
    this.metrics.record(this.turnId, phase, nowMs - this.start, nowMs)
    this.nowMs = nowMs
  }

  /** 分阶段（差值）记录：第一阶段从起点算，之后按上一个标记算。 */
  segment(phase: Phase, nowMs: number): void {
    const last = this.marks.length === 0 ? this.start : (this.marks[this.marks.length - 1]?.atMs ?? this.start)
    this.marks.push({ phase, atMs: nowMs })
    this.metrics.record(this.turnId, phase, nowMs - last, nowMs)
    this.nowMs = nowMs
  }

  elapsed(nowMs: number): number {
    return nowMs - this.start
  }

  get currentMs(): number {
    return this.nowMs
  }
}
