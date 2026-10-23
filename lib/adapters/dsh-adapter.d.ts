/**
 * 宿主适配层（任务书 §13.1）。
 *
 * 这一层把「DSH 宿主到底长什么样」收敛成插件内部要的窄接口：
 *
 *   模型调用  → ModelCaller   （走 ctx.llm.stream，模型名由宿主配置决定）
 *   发送正文  → TurnSender    （走 OneBot HTTP，或退化为宿主最终发送）
 *   提示词    → PromptSections（ctx.systemPrompt.section，带 disposer）
 *
 * 三条硬约束（来自 §13.1，全部在这里兑现）：
 *   1. **不硬编码模型名**：provider/model 每轮从宿主解析，解析不到就降级；
 *   2. **每个注册都返回 disposer**：热重载后不允许残留第二个订阅/定时器；
 *   3. **不启动第二个入站消费者**：本文件只做「出站 + 模型 + 提示词」，
 *      入站消息由 dsh-onebot-qq 桥交给本插件。
 */
import type { Config } from '../config.js';
import type { ModelCaller, ModelCallRequest, ModelChunk, TurnSender } from '../runtime/turn-coordinator.js';
import type { PromptStore } from '../runtime/context-builder.js';
import { QqTransport } from './qq-transport.js';
/** 宿主 ctx 的最小结构：只声明用到的成员，其余按 unknown 处理。 */
export interface HostContext {
    [key: string]: unknown;
}
export interface ResolvedModel {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export interface DshAdapterOptions {
    config: Config;
    transport?: QqTransport | undefined;
    log?: ((message: string) => void) | undefined;
}
/**
 * 解析宿主的默认模型路由。
 *
 * 顺序：`agentDefaultModel.currentSelection()` → `llm.listProviders()` 的第一个。
 * 全都拿不到就返回 null，由调用方降级成 plain 模式（不臆造模型名）。
 */
export declare function resolveDefaultModel(ctx: HostContext): Promise<ResolvedModel | null>;
/** 把宿主的分片流翻成插件内部的 ModelChunk 流。 */
export declare function streamFromHost(ctx: HostContext, route: ResolvedModel, request: ModelCallRequest): AsyncGenerator<ModelChunk>;
/**
 * 模型调用器：每次调用重新解析路由，宿主换模型后不需要重启插件。
 * 解析不到路由时抛错——上层会转成 failed，而不是假装生成成功。
 */
export declare class HostModelCaller {
    private readonly ctx;
    private readonly log;
    constructor(ctx: HostContext, options?: {
        log?: ((message: string) => void) | undefined;
    });
    /** 供 doctor 展示「当前会打到哪个模型」。 */
    route(): Promise<ResolvedModel | null>;
    readonly call: ModelCaller;
}
export interface SenderOptions {
    transport: QqTransport;
    /** conversationId → chatId（`private:123` / `group:456`）。 */
    resolveChatId: (conversationId: string) => string | null;
    log?: ((message: string) => void) | undefined;
}
/**
 * 出站发送器。
 *
 * 注意 §14.4：这里**只负责发**，不负责「要不要发」。
 * expectedInboundSeq 的复核、冷却、取消都由 outbox-worker 在调用前完成；
 * 发送结果原样返回 accepted / rejected / unknown 三态，绝不猜。
 */
export declare class HostTurnSender {
    private readonly transport;
    private readonly resolveChatId;
    private readonly log;
    constructor(options: SenderOptions);
    readonly send: TurnSender;
}
export interface PromptSectionHandle {
    dispose: () => void;
}
export interface PromptSectionOptions {
    /** 段落名，需全局唯一，避免与其它插件撞名。 */
    name: string;
    order: number;
    text: () => string;
}
/**
 * 注册一个系统提示段落，返回 disposer。
 *
 * 宿主没有 systemPrompt 服务时返回 null——调用方据此降级（把提示词并进消息体），
 * 而不是静默丢掉人格设定。
 */
export declare function registerPromptSection(ctx: HostContext, options: PromptSectionOptions): PromptSectionHandle | null;
/** 把人格段落文本拼成宿主可直接注入的一整段（降级路径也用同一份文本）。 */
export declare function composePersonaText(prompts: PromptStore, config: Config): string;
/** 便捷构造：把 config 里的 QQ 通道参数变成 transport。 */
export declare function createTransport(config: Config): QqTransport;
