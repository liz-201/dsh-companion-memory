/**
 * 回合编排（任务书 §6.1–6.7、6.3–6.5、6.8、12.2、14.4）。
 *
 * 前台时间线（§6.2）在这里落成一条直线，每一步都是可重放的显式输入：
 *
 *   入站落库（幂等）
 *     。同会话串行排队（§6.1。
 *     。装配：读状态投。+ 检索记。+ 检查点 。预算测量（。2。
 *     。调模型（流式。
 *     。<say> 关闭 。发送（early send 或交给桥的最终发送）
 *     。<evt> 校验 。应用（评。。情感 。episode 。记忆候。。提醒任务。
 *     。后台巩固入队（前台不等，§17.4。
 *
 * 硬约束：
 *   · 模型看不。evt（。.4）——历史条目只留正文；
 *   · 来源绑定在服务端完成，模型给不了 sourceMessageId（。7.2）；
 *   · 尾部失败不回滚已发出的正文，只记。tail_status（。.3）；
 *   · 任何一步抛错都转成 TurnOutcome.failed，不把异常抛。QQ 桥。
 */
import type { Config } from '../config.js';
import { type Clock, type DeliveryReceipt, type IdentityBinding } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
import type { Retriever } from '../memory/retriever.js';
import type { FactUpdater } from '../memory/fact-updater.js';
import { PromptStore } from './context-builder.js';
import { TokenLedger, type TokenCounter } from './context-budget.js';
import type { ConversationQueue } from './conversation-queue.js';
import { Metrics } from './metrics.js';
import type { BackgroundQueue } from './background-queue.js';
export interface ModelCallRequest {
    turnId: string;
    /** 已装配好的完整输入（人格 + 状。+ 记忆 + 正文）。*/
    systemText: string;
    userText: string;
    thinking: 'disabled' | 'default';
    signal?: AbortSignal;
}
export interface ModelChunk {
    text: string;
    /** provider 上报的用量；没有就留 undefined，绝不填 0。*/
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheHitTokens?: number;
        cacheMissTokens?: number;
        reasoningTokens?: number;
        provider?: string;
        model?: string;
    };
}
/** 宿主模型调用的窄接口：返回异步分片流。模型名由宿主配置决定，不硬编码。*/
export type ModelCaller = (request: ModelCallRequest) => AsyncIterable<ModelChunk>;
export interface SendRequest {
    conversationId: string;
    turnId: string;
    text: string;
    /** 发送前要复核的入站序号（。4.4）。*/
    expectedInboundSeq: number;
}
export type TurnSender = (request: SendRequest) => Promise<DeliveryReceipt>;
export interface InboundTurn {
    binding: IdentityBinding;
    /** 平台会话 id（`private:123` / `group:456`），用于发回同一条通道。*/
    chatId: string;
    text: string;
    platformMessageKey: string | null;
    occurredAtMs: number;
    observedAtMs: number;
    sourceKind?: string;
    /** 宿主 session id；用于检查点与会话映射。*/
    sessionId: string;
    /** 外部已分。turnId 时用它做幂等键。*/
    turnId?: string;
    send?: TurnSender;
    review?: boolean;
}
export type TurnStatus = 'completed' | 'say-only' | 'failed' | 'queued-full' | 'skipped';
export interface TurnOutcome {
    turnId: string;
    status: TurnStatus;
    say: string | null;
    /** evt 是否成功应用；false 表示尾部缺失/非法但正文已发出。*/
    evtApplied: boolean;
    sent: DeliveryReceipt | null;
    injectedMemoryIds: string[];
    budget: string;
    problems: string[];
    error?: string;
    durationMs: number;
}
export interface TurnCoordinatorDeps {
    config: Config;
    repos: Repositories;
    retriever: Retriever;
    updater: FactUpdater;
    queue: ConversationQueue;
    metrics: Metrics;
    ledger: TokenLedger;
    prompts: PromptStore;
    background?: BackgroundQueue | undefined;
    send: TurnSender;
    callModel: ModelCaller;
    clock?: Clock;
    counter?: TokenCounter;
    /** 会话是否处于「已建立的互损语境」——由调用方根据近期事件给出。*/
    teasingContext?: (conversationId: string) => boolean;
    log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}
export declare class TurnCoordinator {
    private readonly deps;
    private readonly clock;
    private readonly counter;
    constructor(deps: TurnCoordinatorDeps);
    /**
     * 处理一条入站消息。返回的结果只用来看日志/测试，调用方不依赖它做业务流程。
     *
     * 幂等：同一 (conversation, platformMessageKey, role=user) 重复到达时，
     * insertRawMessage 返回 inserted=false，这里直。skipped，不会再开一轮模型。
     */
    handleInbound(inbound: InboundTurn): Promise<TurnOutcome>;
    private runTurn;
    /**
     * 应用 evt。返回是否至少应用成功了一个事。候。任务。
     *
     * 来源绑定（。7.2）：模型产出。e 项一律绑定到**当前这条用户消息**。
     * 它自己给的任。id 字段。validateEvt 阶段已被剔除。
     */
    private applyEvt;
    private scheduleConsolidation;
    /** 供命令与测试使用的「纯正文」路径：不调模型，直接把文本发出去。*/
    sendPlain(chatId: string, binding: IdentityBinding, text: string, turnId: string): Promise<DeliveryReceipt>;
}
