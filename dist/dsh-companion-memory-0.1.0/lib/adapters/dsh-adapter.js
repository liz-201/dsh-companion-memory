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
import { QqTransport } from './qq-transport.js';
function asRecord(value) {
    if (value === null || typeof value !== 'object')
        return null;
    return value;
}
function method(value, name) {
    const record = asRecord(value);
    if (!record)
        return null;
    const fn = record[name];
    return typeof fn === 'function' ? fn.bind(value) : null;
}
/**
 * 解析宿主的默认模型路由。
 *
 * 顺序：`agentDefaultModel.currentSelection()` → `llm.listProviders()` 的第一个。
 * 全都拿不到就返回 null，由调用方降级成 plain 模式（不臆造模型名）。
 */
export async function resolveDefaultModel(ctx) {
    const defaults = ctx['agentDefaultModel'];
    const current = method(defaults, 'currentSelection');
    if (current) {
        try {
            const value = await current();
            const record = asRecord(value);
            if (record) {
                const provider = record['provider'];
                const model = record['model'];
                if (typeof provider === 'string' && typeof model === 'string' && provider && model) {
                    const effort = record['reasoningEffort'];
                    return {
                        provider,
                        model,
                        ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
                    };
                }
            }
        }
        catch {
            // 宿主可能还没装配完，继续往下试
        }
    }
    const llm = ctx['llm'];
    const listProviders = method(llm, 'listProviders');
    const listModels = method(llm, 'listModels');
    if (listProviders && listModels) {
        try {
            const providers = (await listProviders());
            if (Array.isArray(providers) && providers.length > 0) {
                const first = asRecord(providers[0]);
                const id = first?.['id'] ?? first?.['provider'];
                if (typeof id === 'string' && id) {
                    const models = (await listModels(id));
                    if (Array.isArray(models) && models.length > 0) {
                        const firstModel = asRecord(models[0]);
                        const modelId = firstModel?.['id'] ?? firstModel?.['model'];
                        if (typeof modelId === 'string' && modelId) {
                            return { provider: id, model: modelId };
                        }
                    }
                }
            }
        }
        catch {
            // 同上
        }
    }
    return null;
}
/** 把宿主的分片流翻成插件内部的 ModelChunk 流。 */
export async function* streamFromHost(ctx, route, request) {
    const llm = ctx['llm'];
    const stream = method(llm, 'stream');
    if (!stream)
        throw new Error('宿主没有 ctx.llm.stream');
    const raw = (await stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        messages: [
            { role: 'system', content: [{ type: 'text', text: request.systemText }] },
            { role: 'user', content: [{ type: 'text', text: request.userText }] },
        ],
        ...(request.signal ? { signal: request.signal } : {}),
    }));
    const iterable = raw;
    for await (const chunk of iterable) {
        const record = asRecord(chunk);
        if (!record)
            continue;
        const type = record['type'];
        if (type === 'text-delta') {
            const text = record['text'];
            if (typeof text === 'string' && text !== '')
                yield { text };
            continue;
        }
        if (type === 'usage') {
            const usage = asRecord(record['usage']) ?? record;
            yield {
                text: '',
                usage: {
                    ...(typeof usage['inputTokens'] === 'number' ? { inputTokens: usage['inputTokens'] } : {}),
                    ...(typeof usage['outputTokens'] === 'number' ? { outputTokens: usage['outputTokens'] } : {}),
                    ...(typeof usage['cacheReadTokens'] === 'number' ? { cacheHitTokens: usage['cacheReadTokens'] } : {}),
                    ...(typeof usage['cacheWriteTokens'] === 'number' ? { cacheMissTokens: usage['cacheWriteTokens'] } : {}),
                    ...(typeof usage['reasoningTokens'] === 'number' ? { reasoningTokens: usage['reasoningTokens'] } : {}),
                    provider: route.provider,
                    model: route.model,
                },
            };
            continue;
        }
        if (type === 'error') {
            const message = record['message'];
            throw new Error(typeof message === 'string' ? message : '宿主模型调用失败');
        }
        // block-start / block-stop / reasoning-delta / finish 等：对正文无贡献
    }
}
/**
 * 模型调用器：每次调用重新解析路由，宿主换模型后不需要重启插件。
 * 解析不到路由时抛错——上层会转成 failed，而不是假装生成成功。
 */
export class HostModelCaller {
    ctx;
    log;
    cached = null;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.log = options.log ?? (() => { });
    }
    /** 供 doctor 展示「当前会打到哪个模型」。 */
    async route() {
        if (this.cached)
            return this.cached;
        this.cached = await resolveDefaultModel(this.ctx);
        if (!this.cached)
            this.log('[companion] 宿主没有可用的默认模型路由，生成将降级为 plain 模式');
        return this.cached;
    }
    call = (request) => {
        const ctx = this.ctx;
        const self = this;
        return (async function* () {
            const route = await self.route();
            if (!route)
                throw new Error('没有可用的模型路由（agentDefaultModel / llm 都不可用）');
            yield* streamFromHost(ctx, route, request);
        })();
    };
}
/**
 * 出站发送器。
 *
 * 注意 §14.4：这里**只负责发**，不负责「要不要发」。
 * expectedInboundSeq 的复核、冷却、取消都由 outbox-worker 在调用前完成；
 * 发送结果原样返回 accepted / rejected / unknown 三态，绝不猜。
 */
export class HostTurnSender {
    transport;
    resolveChatId;
    log;
    constructor(options) {
        this.transport = options.transport;
        this.resolveChatId = options.resolveChatId;
        this.log = options.log ?? (() => { });
    }
    send = async (request) => {
        const chatId = this.resolveChatId(request.conversationId);
        if (!chatId) {
            return { kind: 'rejected', code: 'no-chat-binding', atMs: Date.now() };
        }
        const receipt = await this.transport.sendText(chatId, request.text);
        if (receipt.kind !== 'accepted') {
            this.log(`[companion] 发送未确认 turn=${request.turnId} kind=${receipt.kind} code=${receipt.code ?? '-'}`);
        }
        return receipt;
    };
}
/**
 * 注册一个系统提示段落，返回 disposer。
 *
 * 宿主没有 systemPrompt 服务时返回 null——调用方据此降级（把提示词并进消息体），
 * 而不是静默丢掉人格设定。
 */
export function registerPromptSection(ctx, options) {
    const systemPrompt = ctx['systemPrompt'];
    const section = method(systemPrompt, 'section');
    if (!section)
        return null;
    try {
        const disposer = section({
            name: options.name,
            order: options.order,
            interpolate: false,
            text: options.text,
        });
        return {
            dispose: () => {
                if (typeof disposer === 'function')
                    disposer();
            },
        };
    }
    catch {
        return null;
    }
}
/** 把人格段落文本拼成宿主可直接注入的一整段（降级路径也用同一份文本）。 */
export function composePersonaText(prompts, config) {
    const bundle = prompts.load(config.companion.preset);
    const parts = [bundle.persona.trim(), bundle.protocol.trim()].filter((part) => part !== '');
    return parts.join('\n\n');
}
/** 便捷构造：把 config 里的 QQ 通道参数变成 transport。 */
export function createTransport(config) {
    return new QqTransport({
        httpBase: config.channel.onebotHttpBase,
        accessToken: config.channel.accessToken,
    });
}
//# sourceMappingURL=dsh-adapter.js.map