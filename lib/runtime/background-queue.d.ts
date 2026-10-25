/**
 * 后台任务队列（任务书 §6.1、§17.4、§10.5）。
 *
 * 目标：把「巩固记忆 / 后台提取 / 备份」这类慢动作挪出前台回合，且
 *   · 前台永远不等后台（§17.4「防止后台拖慢」）；
 *   · 同一 dedup_key 不会重复入队（重启、重试都靠它）；
 *   · 每次执行都有租约，进程崩了租约会自然过期，不产生永久锁；
 *   · 一个 timer，一个 worker，卸载时必须能停掉（§13.1 disposer）。
 *
 * 租约生命周期（ROUND2）：
 *   · 每次只领取「马上要跑的那一条」，所以还没开始的任务不会替前一条背租约；
 *   · handler 运行期间按 renewEveryMs（默认 leaseMs/3）周期续租，长任务不会被判成孤儿；
 *   · 续租 / 完成 / 失败重排都用 `id + status='leased' + 当前 attempts` 做条件更新，
 *     租约被别的 worker 接管后，旧 handler 的回写一律落空，不会覆盖新状态；
 *   · stop() 之后不再领下一条，正在跑的那条允许正常收尾（续租继续到它结束）。
 *   · 一轮 tick 内只有一个逻辑时钟：显式 nowMs 是本轮起点，其余时刻一律叠加注入时钟的增量；
 *     领取、续租、失败退避都读它，所以长 handler 跑过退避窗口再失败也不会在同一 tick 里重跑。
 *
 * 这里只管「调度与执行边界」，具体做什么由 handler 决定。
 */
import type { Repositories } from '../storage/repositories.js';
import type { Metrics } from './metrics.js';
export type JobKind = 'consolidate' | 'extract' | 'backup';
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
    attempt: number;
    previousError: string | null;
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
    /** 续租间隔；默认 leaseMs / 3。 */
    renewEveryMs?: number;
    /** 时钟注入（测试用固定时钟）；默认 Date.now。 */
    now?: () => number;
}
export interface BackgroundStats {
    running: boolean;
    tickMs: number;
    claimedTotal: number;
    doneTotal: number;
    failedTotal: number;
    /** 租约被接管后放弃回写的次数（旧 worker 落空，不算成功也不算失败）。 */
    staleTotal: number;
    /** 成功续租次数，用来观察长任务是否真的在续。 */
    renewals: number;
    /** 当前持租约在跑的任务数。 */
    activeLeases: number;
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
    private readonly renewEveryMs;
    private readonly clock;
    private timer;
    private running;
    private stopping;
    private claimedTotal;
    private doneTotal;
    private failedTotal;
    private staleTotal;
    private renewals;
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
    /**
     * 回收孤儿租约：启动时不可能持有任何租约，所以「已过期」的行一定是上次崩溃留下的。
     * 只碰已过期的行，不抢另一个活进程正在跑的任务（长任务靠周期续租保持「活」）。
     *
     * 连续过期不能绕过重试上限：handler 每次都在租约内跑不完（或每次把进程带走）时，
     * 光靠「重新排队」会变成无限重启循环。这里沿用失败路径的同一份预算
     * （共 maxRetries + 1 次执行），用完即判终结失败，和正常重试的语义一致。
     */
    reclaimOrphans(nowMs?: number, maxAttempts?: number): number;
    start(): void;
    /**
     * 一轮调度：最多跑 batch 条，但**每次只领一条**。
     *
     * 整批预领的代价是：第一条长任务跑超 leaseMs 时，还没开始的第 2..n 条也一起过期，
     * 被另一个 worker 重领——它们既没被执行过，也白白烧掉一次重试预算。
     */
    tick(nowMs?: number): Promise<void>;
    /** 跑一条已领到租约的任务：续租 → 执行 → 条件回写 → 清理续租。 */
    private runOne;
    /**
     * 运行期间周期续租。返回的 disposer 必须在 finally 里调用。
     * 续租失败（库关闭 / 租约已被接管）立即停表，不重试、不放大。
     */
    private startRenewal;
    private clearRenewal;
    /** 租约被接管：不覆盖新 worker 的状态，只记一笔可观测性。 */
    private abandonStale;
    /** 等当前在跑的任务收尾（卸载时用，最多等 timeoutMs）。 */
    drain(timeoutMs?: number): Promise<boolean>;
    stop(): void;
    stats(): BackgroundStats;
    /** 供 doctor 展示的「库里还剩多少任务」。 */
    backlog(): Record<string, number>;
    get isRunning(): boolean;
}
