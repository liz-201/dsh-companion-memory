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
import type { Repositories } from '../storage/repositories.js';
export type Phase = 'assembly' | 'retrieval' | 'queue-wait' | 'provider-first-token' | 'say-close' | 'evt-apply' | 'send' | 'total';
export declare const PHASES: readonly Phase[];
/** §17.1 的验收目标；报告里逐项对比，达不到就如实写「未达标」。 */
export declare const LATENCY_TARGETS_MS: Readonly<Record<Phase, number>>;
export interface Sample {
    turnId: string;
    phase: Phase;
    ms: number;
    atMs: number;
}
export interface PhaseStat {
    phase: Phase;
    count: number;
    p50: number;
    p95: number;
    max: number;
    targetMs: number;
    met: boolean;
}
export interface MetricsSnapshot {
    stats: PhaseStat[];
    counters: Record<string, number>;
    degraded: string[];
    samplesKept: number;
}
export declare class Metrics {
    private readonly samples;
    private readonly counters;
    private readonly degraded;
    private readonly limit;
    private repos;
    /** Daily counters survive restarts; timing samples remain a bounded in-memory window. */
    attachStorage(repos: Repositories): void;
    /** cap 防止长跑进程无限增长；超出后丢最旧的样本（计数器不受影响）。 */
    constructor(limit?: number);
    record(turnId: string, phase: Phase, ms: number, atMs: number): void;
    /** 用一对时间戳记录一段耗时；缺任一端就跳过（不把未知当 0）。 */
    span(turnId: string, phase: Phase, startedAtMs: number | undefined, endedAtMs: number): void;
    count(name: string, delta?: number): void;
    /** 降级原因去重记录，doctor 与 /fish status 直接展示。 */
    degrade(reason: string): void;
    stats(): PhaseStat[];
    snapshot(): MetricsSnapshot;
    /** 一行人类可读摘要，供日志与 /fish status。 */
    summary(): string;
    clear(): void;
}
/**
 * 简单的一次性秒表：调用方 start()，phase() 记录中间点。
 * 不依赖 Date.now 的隐式调用——clock 由参数传入，测试可注入固定时钟。
 */
export declare class TurnStopwatch {
    readonly turnId: string;
    private readonly metrics;
    private nowMs;
    private readonly marks;
    private readonly start;
    constructor(turnId: string, metrics: Metrics, nowMs: number);
    tick(nowMs: number): void;
    mark(phase: Phase, nowMs: number): void;
    /** 分阶段（差值）记录：第一阶段从起点算，之后按上一个标记算。 */
    segment(phase: Phase, nowMs: number): void;
    elapsed(nowMs: number): number;
    get currentMs(): number;
}
