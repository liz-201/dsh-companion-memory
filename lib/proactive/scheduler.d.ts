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
import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { Metrics } from '../runtime/metrics.js';
import { type Candidate } from './candidate-builder.js';
export interface SchedulerConversation {
    conversationId: string;
    principalId: string;
    /** 关系状态，用于排序；缺省按中性处理。 */
    grievance?: number;
    affection?: number;
    unresolvedConflict?: boolean;
}
export interface SchedulerOptions {
    config: Config;
    repos: Repositories;
    metrics: Metrics;
    /** 列出应当被扫描的会话；由适配层根据绑定与启用状态给出。 */
    listConversations: () => SchedulerConversation[];
    /** 生成一条主动消息的正文；返回 null 表示这次放弃，不写 outbox。 */
    generate: (input: {
        candidate: Candidate;
        conversation: SchedulerConversation;
    }) => Promise<string | null>;
    /** 主回合是否在跑（避免插队）。 */
    mainTurnInFlight?: (conversationId: string) => boolean;
    prepare?: (conversationId: string, content: string, expectedSeq: number, candidateKey: string) => Promise<string | null>;
    beforeScan?: (nowMs: number) => Promise<void>;
    now?: () => number;
    log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}
export interface SchedulerScanResult {
    scanned: number;
    gatesBlocked: number;
    candidates: number;
    generated: number;
    enqueued: number;
    skipped: {
        conversationId: string;
        reason: string;
    }[];
}
export declare class ProactiveScheduler {
    private readonly options;
    private readonly now;
    private timer;
    private scanning;
    constructor(options: SchedulerOptions);
    get running(): boolean;
    get busy(): boolean;
    /** 启动周期扫描；重复调用不会产生第二个 timer（热重载安全）。 */
    start(): void;
    stop(): void;
    /** 单次扫描。测试直接调它，不依赖真实时间。 */
    scan(nowMs?: number): Promise<SchedulerScanResult>;
    private scanOne;
    private safeGenerate;
}
