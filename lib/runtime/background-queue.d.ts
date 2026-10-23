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
import type { Repositories } from '../storage/repositories.js';
import type { Metrics } from './metrics.js';
export type JobKind = 'consolidate' | 'extract' | 'backup' | 'prune' | 'proactive-scan';
export interface JobPayload {
    conversationId?: string;
    principalId?: string;
    afterSeq?: number;
    [key: string]: unknown;
}
export type JobHandler = (job: {
    id: string;
    kind: string;
    payload: JobPayload;
}) => Promise<void> | void;
export interface BackgroundQueueOptions {
    /** 轮询间隔；默认 5s。 */
    tickMs?: number;
    /** 单次租约；默认 60s。崩溃后最多这么久自愈。 */
    leaseMs?: number;
    /** 单轮最多取几个；默认 2。 */
    batch?: number;
    /** 是否在后台真的跑（关闭后只入队不执行，测试用）。 */
    enabled?: boolean;
    maxRetries?: number;
}
export interface BackgroundStats {
    running: boolean;
    tickMs: number;
    claimedTotal: number;
    doneTotal: number;
    failedTotal: number;
    lastError: string | null;
    handlers: string[];
}
export declare class BackgroundQueue {
    private readonly repos;
    private readonly metrics;
    private readonly options;
    private readonly handlers;
    private readonly tickMs;
    private readonly leaseMs;
    private readonly batch;
    private readonly maxRetries;
    private timer;
    private running;
    private stopping;
    private claimedTotal;
    private doneTotal;
    private failedTotal;
    private lastError;
    private inFlight;
    constructor(repos: Repositories, metrics: Metrics, options?: BackgroundQueueOptions);
    /** 注册一种任务的执行体；重复注册同一 kind 直接覆盖（热重载友好）。 */
    register(kind: JobKind, handler: JobHandler): void;
    /** 入队；dedup_key 已存在时返回 false。 */
    enqueue(kind: JobKind, payload: JobPayload, options: {
        dedupKey: string;
        availableAtMs: number;
        nowMs: number;
        principalId?: string | null;
    }): boolean;
    start(): void;
    tick(nowMs?: number): Promise<void>;
    /** 等当前在跑的任务收尾（卸载时用，最多等 timeoutMs）。 */
    drain(timeoutMs?: number): Promise<boolean>;
    stop(): void;
    stats(): BackgroundStats;
    /** 供 doctor 展示的「库里还剩多少任务」。 */
    backlog(): Record<string, number>;
    get isRunning(): boolean;
}
