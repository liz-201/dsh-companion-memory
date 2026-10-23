/**
 * 同一会话串行队列（任务书 §6.1）。
 *
 * 硬规则：
 *   · 同一 conversationId 内严格 FIFO，前一轮没结束就不开下一轮；
 *   · 不同会话互不阻塞；
 *   · 排队有上限，满了要明确拒绝（返回 queued:false + 原因），不能无限堆积；
 *   · 每个任务都有 turnId，重复投递同一个 turnId 直接去重（重连、重试都靠它）；
 *   · 队列关闭（卸载 / 热重载）后新任务一律拒绝，已在跑的允许跑完并清理计时器。
 */
import type { QueuedTurnTask } from '../domain/types.js';
export interface QueueOptions {
    /** 每个会话最多排队多少个待处理任务（不含正在跑的）。 */
    maxPendingPerConversation?: number;
    /** 等待超时（毫秒）；超时的任务直接拒绝，避免永久挂起。 */
    waitTimeoutMs?: number;
}
export interface EnqueueResult {
    queued: boolean;
    /** 已在队列中的话返回其位置（0 = 下一个就轮到它）。 */
    position: number;
    /** 与 turnId 相同的任务已在队列里，这次是幂等重复。 */
    duplicate: boolean;
    reason?: 'closed' | 'full' | 'timeout';
}
export interface QueueStats {
    conversations: number;
    running: number;
    pending: number;
    dropped: number;
    completed: number;
    failed: number;
}
export declare class ConversationQueue {
    private readonly lanes;
    private readonly maxPending;
    private readonly waitTimeoutMs;
    private closed;
    private dropped;
    private completed;
    private failed;
    constructor(options?: QueueOptions);
    /** 排队并等待执行完成；调用方 await 它即可拿到这一轮的结束点。 */
    run(task: QueuedTurnTask): Promise<EnqueueResult>;
    /** 只排队不等待（后台任务、主动消息用）。 */
    enqueue(task: QueuedTurnTask): EnqueueResult;
    /** 是否正在处理某个会话（主动消息调度前要查）。 */
    isBusy(conversationId: string): boolean;
    /** 取消某个 turn 的排队（用户撤回、任务过期）。正在跑的不动。 */
    cancel(conversationId: string, turnId: string): boolean;
    stats(): QueueStats;
    /** 卸载 / 热重载：拒绝新任务，清空等待中的计时器与 rejected promise。 */
    close(): void;
    get isClosed(): boolean;
    private lane;
    private pump;
}
