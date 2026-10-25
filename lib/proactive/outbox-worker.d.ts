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
import type { Config } from '../config.js';
import type { DeliveryReceipt } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
import type { QqTransport } from '../adapters/qq-transport.js';
import type { Metrics } from '../runtime/metrics.js';
export type OutboxOutcome = {
    id: string;
    status: 'sent';
    receipt: DeliveryReceipt;
    chatId: string;
} | {
    id: string;
    status: 'failed';
    receipt: DeliveryReceipt;
    chatId: string;
    retryable: boolean;
} | {
    id: string;
    status: 'unknown';
    receipt: DeliveryReceipt;
    chatId: string;
} | {
    id: string;
    status: 'cancelled';
    reason: string;
    chatId: string | null;
};
export interface OutboxWorkerOptions {
    config: Config;
    repos: Repositories;
    transport: QqTransport;
    metrics: Metrics;
    /** 会话 → 平台 chatId（`private:123` / `group:456`）。返回 null 表示这个会话不该外发。 */
    chatForConversation: (conversationId: string) => string | null;
    now?: () => number;
    limit?: number;
    send?: (conversationId: string, content: string, key: string, expectedSeq: number | null) => Promise<DeliveryReceipt>;
    targetBusy?: (conversationId: string) => boolean;
}
export declare class OutboxWorker {
    private readonly options;
    private readonly now;
    private running;
    constructor(options: OutboxWorkerOptions);
    /**
     * 取一批待发消息并逐条投递。
     *
     * 返回的每一项都对应 outbox 里真实发生过的一次状态变化，供 scheduler 记账
     * 与 `/fish status` 展示；调用方不依赖它做业务判断。
     */
    runOnce(nowMs?: number): Promise<OutboxOutcome[]>;
    /** 发送前复核（§14.4）。返回取消原因，null 表示可以发。 */
    private recheck;
}
