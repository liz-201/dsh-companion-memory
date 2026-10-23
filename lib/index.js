import { ReviewSandbox } from './runtime/review-sandbox.js';
/** Compose request-scoped companion services; no global persona or second QQ connection. */
import { resolveConfig } from './config.js';
import { openDatabase } from './storage/database.js';
import { migrate } from './storage/migrations.js';
import { Repositories } from './storage/repositories.js';
import { backupNow, backupDirectory, pruneBackups, listBackups } from './storage/backup.js';
import { Retriever } from './memory/retriever.js';
import { FactUpdater } from './memory/fact-updater.js';
import { Consolidator, hashKey } from './memory/consolidator.js';
import { PromptStore, renderStateBlock } from './runtime/context-builder.js';
import { Metrics } from './runtime/metrics.js';
import { TokenLedger } from './runtime/context-budget.js';
import { ConversationQueue } from './runtime/conversation-queue.js';
import { TurnCoordinator } from './runtime/turn-coordinator.js';
import { BackgroundQueue } from './runtime/background-queue.js';
import { ProactiveScheduler } from './proactive/scheduler.js';
import { OutboxWorker } from './proactive/outbox-worker.js';
import { handleFishCommand, looksLikeFishCommand, stripFishPrefix } from './commands/handlers.js';
import { QqTransport, chatForSession } from './adapters/qq-transport.js';
import { HostModelCaller, HostTurnSender, composePersonaText, createTransport } from './adapters/dsh-adapter.js';
import { probeCapabilities, describeCompatibility } from './adapters/compatibility.js';
import { formatChatId, parseChatId, resolveBinding, decideActivation } from './domain/identity.js';
import { PRESETS } from './domain/affect-reducer.js';
/** Cordis 插件名。 */
export const name = 'dsh-companion-memory'; /** * 依赖的服务。 *
* 全部声明为 optional：缺 `systemPrompt` 就退化成「把人格并进消息体」，
* 缺 `llm` 就退化成 plain 模式，缺 `commands` 只是没有斜杠命令——
* 但插件本身必须还能加载并如实报告降级（§18.3）。 */
export const inject = {
    required: [],
    optional: [
        'systemPrompt',
        'llm',
        'commands',
        'tools',
        'webServer',
        'agents',
        'sessions',
        'agentDefaultModel',
    ],
};
const VERSION = '0.1.1';
const MEMORY_KINDS = ['episode', 'fact', 'preference', 'interaction_rule', 'hypothesis'];
function logger(level, message) {
    const prefix = '[companion]';
    if (level === 'error')
        console.error(prefix, message);
    else if (level === 'warn')
        console.warn(prefix, message);
    else
        console.log(prefix, message);
}
function toRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
function pickString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : null;
}
/** 从模型输出里抠出第一个 JSON 对象（巩固任务只接受结构化变更）。 */
function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function coerceChanges(value) {
    if (!Array.isArray(value))
        return [];
    const changes = [];
    for (const raw of value) {
        const record = toRecord(raw);
        const kind = pickString(record, 'kind');
        const claim = pickString(record, 'claim');
        const quote = pickString(record, 'quote');
        const ids = record['sourceMessageIds'];
        if (kind === null || claim === null || quote === null)
            continue;
        if (!MEMORY_KINDS.includes(kind))
            continue;
        if (!Array.isArray(ids) || ids.length === 0)
            continue;
        const sourceMessageIds = ids.filter((id) => typeof id === 'string');
        if (sourceMessageIds.length === 0)
            continue;
        changes.push({
            kind: kind,
            subject: pickString(record, 'subject'),
            predicate: pickString(record, 'predicate'),
            object: record['object'] ?? null, claim,
            sourceMessageIds, quote,
            confidence: typeof record['confidence'] === 'number' ? record['confidence'] : 0.6,
            salience: typeof record['salience'] === 'number' ? record['salience'] : 0.5,
            eventAtMs: typeof record['eventAtMs'] === 'number' ? record['eventAtMs'] : null,
        });
    }
    return changes;
}
/** 装配插件。 */
export function apply(ctx, rawConfig) {
    const config = structuredClone(resolveConfig(rawConfig));
    const store = new PromptStore();
    const metrics = new Metrics();
    const ledger = new TokenLedger();
    const prompts = store;
    const db = openDatabase(config.storage, false, config.companion.id);
    migrate(db, {
        now: Date.now(), fts5: db.capabilities().fts5
    });
    const repos = new Repositories(db);
    repos.recoverOutbox();
    const savedProactive = repos.getSetting('proactive.enabled');
    if (savedProactive !== undefined)
        config.proactive.enabled = savedProactive === '1';
    const savedPreset = repos.getSetting('companion.preset');
    if (savedPreset === 'irritable' || savedPreset === 'balanced' || savedPreset === 'gentle')
        config.companion.preset = savedPreset;
    const review = new ReviewSandbox(repos, config);
    repos.ensureCompanion(config.companion.id, config.companion.name, PRESETS[config.companion.preset], Date.now());
    const retriever = new Retriever(repos, config.memory);
    const updater = new FactUpdater(repos, config.memory);
    const consolidator = new Consolidator(repos, config.background, updater);
    const transport = createTransport(config);
    const modelCaller = new HostModelCaller(ctx, {
        log: (message) => logger('info', message)
    });
    const queue = new ConversationQueue({});
    const background = new BackgroundQueue(repos, metrics, {
        enabled: true,
        maxRetries: config.background.retryLimit,
    });
    /** 已知会话：chatId ↔ conversationId，供发送与主动消息反查。 */
    const chatByConversation = new Map();
    const conversationBySession = new Map();
    /** 已由本插件发过正文的 turnId（§13.2 默认抑制桥的最终发送）。 */
    const consumedTurns = new Set();
    const sender = new HostTurnSender({
        transport,
        resolveChatId: (conversationId) => chatByConversation.get(conversationId) ?? null,
        log: (message) => logger('warn', message),
    });
    const coordinator = new TurnCoordinator({
        config, repos,
        retriever, updater, queue, metrics, ledger, prompts,
        background,
        send: sender.send,
        callModel: modelCaller.call,
        log: logger,
    });
    const outbox = new OutboxWorker({
        config, repos,
        transport, metrics,
        chatForConversation: (conversationId) => chatByConversation.get(conversationId) ?? null,
        now: () => Date.now(),
    });
    /** 主动消息正文生成；解析不到路由就放弃这次（不臆造模型名）。 */
    const generateProactive = async (input) => {
        const route = await modelCaller.route();
        if (!route)
            return null;
        const stored = repos.getSnapshot(input.conversation.principalId);
        const stateText = stored === undefined ? '' : renderStateBlock(stored.snapshot);
        const systemText = composePersonaText(prompts, config);
        const userText = [
            '现在是你在主动开口（不是回复用户）。',
            `起因：${input.candidate.kind} — ${input.candidate.topic}`,
            input.candidate.reasons.length > 0 ? `依据：${input.candidate.reasons.join('；')}` : '',
            stateText,
            '要求：一句话到两句话，口语，不要解释你为什么说话，不要提“系统”“任务”“提醒设置”。',
            '只输出正文，不要 JSON，不要引号包裹。',
        ]
            .filter((line) => line !== '')
            .join('\n');
        const parts = [];
        for await (const chunk of modelCaller.call({
            turnId: `proactive-${hashKey(input.conversation.conversationId + input.candidate.topic)}`,
            systemText, userText,
            thinking: 'disabled',
        })) {
            parts.push(chunk.text);
        }
        const text = parts.join('').trim();
        return text === '' ? null : text;
    };
    const scheduler = new ProactiveScheduler({
        config, repos, metrics,
        listConversations: () => [...chatByConversation.entries()].filter(([id]) => !id.startsWith('review:')).map(([conversationId, chatId]) => {
            const binding = bindingForConversation(conversationId, chatId);
            const stored = binding === null ? null : repos.getSnapshot(binding.principalId);
            return {
                conversationId,
                principalId: binding?.principalId ?? conversationId,
                grievance: stored?.snapshot.relationship.grievance ?? 0,
                affection: stored?.snapshot.relationship.affection ?? 0,
                unresolvedConflict: binding !== null && repos.listEpisodes(binding.principalId, ['open', 'repairing'], 1).length > 0,
            };
        }),
        generate: generateProactive,
        mainTurnInFlight: (conversationId) => queue.isBusy(conversationId),
        log: logger,
    });
    /** 由 chatId 还原绑定（入站、主动、命令都走这一条路径，保证口径一致）。 */
    function bindingForConversation(conversationId, chatId) {
        const parsed = parseChatId(chatId);
        if (!parsed)
            return null;
        const row = db.get('SELECT p.bot_account_id, p.user_id FROM conversations c JOIN principals p ON p.id = c.principal_id WHERE c.id = ?', conversationId);
        return resolveBinding({ companionId: config.companion.id, botAccountId: row?.bot_account_id ?? 'self', userId: row?.user_id ?? parsed.id, conversationId, conversationKind: parsed.kind });
    }
    function realBinding(chatId, botAccountId = 'self', userId) {
        const parsed = parseChatId(chatId);
        const conversationId = botAccountId === 'self'
            ? `${config.companion.id}:${parsed.kind}:${parsed.id}`
            : `${config.companion.id}:${botAccountId}:${parsed.kind}:${parsed.id}`;
        const binding = resolveBinding({ companionId: config.companion.id, botAccountId, userId: parsed.kind === 'private' ? parsed.id : userId ?? parsed.id, conversationId, conversationKind: parsed.kind });
        repos.ensurePrincipal(binding.principalId, config.companion.id, binding.botAccountId, binding.userId, Date.now());
        repos.ensureConversation(conversationId, binding.principalId, parsed.kind, chatId, Date.now());
        return binding;
    }
    // Restore known targets so confirmed reminders survive a process restart before the next inbound.
    for (const row of db.all("SELECT id, kind, platform_conversation_id FROM conversations WHERE enabled = 1 AND id NOT LIKE 'review:%'")) {
        const chatId = row.platform_conversation_id.includes(':') ? row.platform_conversation_id : formatChatId(row.kind, row.platform_conversation_id);
        if (decideActivation(config.companion, config.channel, chatId).active)
            chatByConversation.set(row.id, chatId);
    }
    /** 记住 chatId ↔ conversationId 的关系，供主动消息与命令反查。 */
    function rememberChat(binding, chatId, sessionId) {
        chatByConversation.set(binding.conversationId, chatId);
        if (typeof sessionId === 'string' && sessionId !== '') {
            conversationBySession.set(sessionId, binding.conversationId);
        }
    }
    // ── 后台任务 ────────────────────────────────────────────────────────────────
    background.register('consolidate', async (job) => {
        const conversationId = pickString(job.payload, 'conversationId');
        const principalId = pickString(job.payload, 'principalId');
        const afterSeq = Number(repos.getSetting(`consolidation.cursor:${conversationId}`) ?? job.payload['afterSeq'] ?? 0);
        if (conversationId === null || principalId === null)
            return;
        const batch = consolidator.planBatch({
            conversationId, principalId, afterSeq
        });
        if (batch.messages.length === 0) {
            repos.setSetting(`consolidation.cursor:${conversationId}`, String(batch.cursor), Date.now());
            return;
        }
        const route = await modelCaller.route();
        if (!route) {
            throw new Error('巩固任务等待可用的模型路由');
        }
        const transcript = batch.messages
            .map((message) => `[${message.id}] ${message.role}: ${message.content}`)
            .join('\n');
        const parts = [];
        for await (const chunk of modelCaller.call({
            turnId: `bg-${job.id}`,
            systemText: prompts.consolidate(),
            userText: `消息如下：\n${transcript}`,
            thinking: 'disabled',
        })) {
            parts.push(chunk.text);
        }
        const parsed = toRecord(extractJson(parts.join('')));
        const plan = {
            changes: coerceChanges(parsed['changes']),
            cursor: typeof parsed['cursor'] === 'number' ? parsed['cursor'] : null,
            summary: pickString(parsed, 'summary'),
        };
        const report = consolidator.applyPlan(batch, plan, Date.now());
        repos.setSetting(`consolidation.cursor:${conversationId}`, String(report.nextCursor), Date.now());
        repos.putCheckpoint({
            id: hashKey(`checkpoint:${conversationId}:${report.nextCursor}`), conversationId,
            sessionId: 'background',
            summary: { topic: plan.summary ?? '' },
            evidenceIds: report.touchedIds,
            createdAtMs: Date.now(),
        });
        repos.audit({
            principalId,
            kind: 'consolidate',
            entityId: conversationId,
            payload: {
                applied: report.applied, rejected: report.rejected.length
            },
            createdAtMs: Date.now(),
        });
    });
    background.register('backup', () => {
        backupNow(db, {
            directory: backupDirectory(db.file),
            keepDays: config.storage.backupRetentionDays,
            label: config.companion.id,
        }, Date.now());
        pruneBackups(backupDirectory(db.file), config.storage.backupRetentionDays, Date.now());
    });
    // ── 服务 ────────────────────────────────────────────────────────────────────
    let active = true;
    const service = {
        version: VERSION,
        accepts(chatId) { return active && decideActivation(config.companion, config.channel, chatId).active; },
        async handleInbound(input) {
            if (!service.accepts(input.chatId) || config.generation.mode === 'plain')
                return { handled: false, replySuppressed: false, outcome: null, reason: 'scope-disabled' };
            const parsed = parseChatId(input.chatId);
            if (parsed.kind === 'group' && !input.userId)
                return { handled: false, replySuppressed: false, outcome: null, reason: 'missing-group-user' };
            const real = realBinding(input.chatId, input.botAccountId, input.userId);
            rememberChat(real, input.chatId, input.sessionId);
            const sandbox = review.binding(real);
            const binding = sandbox ?? real;
            rememberChat(binding, input.chatId, input.sessionId);
            if (looksLikeFishCommand(input.text)) {
                const result = service.handleCommand({ text: input.text, chatId: input.chatId, botAccountId: input.botAccountId });
                if (input.send)
                    await input.send(result.text, `command-${Date.now()}`);
                return { handled: true, replySuppressed: true, outcome: null, reason: 'command' };
            }
            const inbound = { binding, chatId: input.chatId, text: input.text,
                platformMessageKey: input.platformMessageKey ?? null, occurredAtMs: input.occurredAtMs ?? Date.now(), observedAtMs: Date.now(),
                sessionId: input.sessionId ?? `chat:${input.chatId}`, sourceKind: input.sourceKind ?? 'qq', review: sandbox !== null,
                ...(input.send ? { send: request => input.send(request.text, request.turnId) } : {}) };
            const outcome = await coordinator.handleInbound(inbound);
            // Once handled, even an unknown receipt must suppress the original bridge's fallback send.
            consumedTurns.add(outcome.turnId);
            if (consumedTurns.size > 2000)
                consumedTurns.delete(consumedTurns.values().next().value);
            return { handled: true, replySuppressed: true, outcome };
        },
        handleCommand(input) {
            const parsed = parseChatId(input.chatId);
            if (!parsed)
                return {
                    kind: 'error', text: '这个会话没有可用的身份绑定。'
                };
            if (!service.accepts(input.chatId))
                return { kind: 'error', text: '此会话没有启用陪伴功能。' };
            const existingConversation = [...chatByConversation.entries()].find(([id, chat]) => chat === input.chatId && !id.startsWith('review:'));
            const real = input.botAccountId ? realBinding(input.chatId, input.botAccountId) : existingConversation ? bindingForConversation(existingConversation[0], input.chatId) : realBinding(input.chatId);
            const raw = stripFishPrefix(input.text);
            const binding = /^review(?:\s|$)/.test(raw) ? real : review.binding(real) ?? real;
            const isOwner = parsed.kind === 'private' && config.channel.ownerChats.includes(input.chatId);
            return handleFishCommand({
                raw: stripFishPrefix(input.text), binding, isOwner, nowMs: Date.now()
            }, {
                review: {
                    begin: (fixture) => { if (queue.isBusy(real.conversationId))
                        throw new Error('当前回合尚未结束，请稍后进入 review。'); return review.begin(real, fixture, Date.now()); },
                    end: () => { const active = review.binding(real); if (active && queue.isBusy(active.conversationId))
                        throw new Error('测试回合尚未结束，请稍后退出。'); return review.end(real); },
                },
                config, repos, db,
                retriever, updater, metrics,
                compatibility: () => service.compatibility(),
                scheduler: {
                    status: () => ({
                        enabled: config.proactive.enabled,
                        pending: repos.counts().outbox ?? 0,
                        lastScanAtMs: null,
                        nextCheckAtMs: null,
                    }),
                    setEnabled: (enabled) => {
                        config.proactive.enabled = enabled;
                    },
                },
                outboxStats: () => repos.counts(),
                backgroundStats: () => background.backlog(),
                log: (message) => logger('info', message),
            });
        },
        isCommand: looksLikeFishCommand,
        status() {
            return {
                version: VERSION,
                companion: config.companion,
                delivery: transport.configured ? 'bridge' : 'plain-body-only',
                chats: chatByConversation.size,
                counts: repos.counts(),
                metrics: metrics.summary(),
                background: background.stats(),
                scheduler: scheduler.running,
                database: db.file,
                capabilities: service.compatibility().capabilities,
            };
        },
        compatibility() {
            return probeCapabilities(ctx, {
                onebotHttpBase: config.channel.onebotHttpBase,
                chatSessionsFile: config.channel.chatSessionsFile,
            });
        },
        consumed(turnId) {
            return consumedTurns.has(turnId);
        },
        async shutdown() {
            disposeAll();
        },
    };
    ctx.provide?.('companionMemory', service);
    ctx.emit?.('companionMemory/available');
    // ── 提示词段 ────────────────────────────────────────────────────────────────
    const commandDisposer = ctx.commands?.register({
        name: 'fish',
        description: '陪伴插件：status / mood / why / memory / remember / forget / correct / personality / proactive / reset / export / doctor',
        input: {
            hint: 'status | mood | why | memory <关键词> | remember <内容> | forget <id> --confirm'
        },
        handler: (input) => {
            const rawInput = typeof input.rawInput === 'string' ? input.rawInput : '';
            const chatId = chatIdForAgent(input.agent);
            if (!chatId)
                return { kind: 'error', text: '请在已绑定的 QQ 私聊使用 /fish。' };
            const result = service.handleCommand({
                text: `/fish ${rawInput}`, chatId
            });
            return {
                kind: result.kind, text: result.text
            };
        },
    });
    function chatIdForAgent(agent) {
        const record = toRecord(agent);
        const session = toRecord(record['session']);
        const sessionId = pickString(session, 'id');
        if (sessionId === null)
            return null;
        const known = conversationBySession.get(sessionId);
        if (known !== undefined) {
            const chatId = chatByConversation.get(known);
            if (chatId !== undefined)
                return chatId;
        }
        const fromFile = chatForSession(config.channel.chatSessionsFile, sessionId);
        return fromFile;
    }
    // ── 诊断路由（仅回环） ──────────────────────────────────────────────────────
    let webDisposer;
    const webServer = ctx.webServer ?? ctx.get?.('webServer');
    if (webServer && typeof webServer.register === 'function') {
        webDisposer = webServer.register({
            kind: 'prefix',
            path: '/companion-memory',
            handler: (req, res) => {
                const response = res;
                const request = req;
                const remote = String(request.socket?.remoteAddress ?? '');
                const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
                const body = loopback
                    ? JSON.stringify({
                        ok: true, status: service.status(), compatibility: describeCompatibility(service.compatibility())
                    })
                    : JSON.stringify({
                        ok: false, error: 'loopback only'
                    });
                response.writeHead?.(loopback ? 200 : 403, {
                    'content-type': 'application/json; charset=utf-8'
                });
                response.end?.(body);
            },
        });
    }
    // ── 定时器 ──────────────────────────────────────────────────────────────────
    let outboxTimer = null;
    let backupTimer = null;
    background.start();
    scheduler.start();
    outboxTimer = setInterval(() => {
        void outbox.runOnce().catch((error) => {
            logger('warn', `主动消息投递失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }, 30_000);
    outboxTimer.unref?.();
    if (config.storage.backupDaily) {
        backupTimer = setInterval(() => {
            backupNow(db, {
                directory: backupDirectory(db.file),
                keepDays: config.storage.backupRetentionDays,
                label: config.companion.id,
            }, Date.now());
        }, 24 * 60 * 60 * 1000);
        backupTimer.unref?.();
    }
    const report = service.compatibility();
    logger('info', describeCompatibility(report));
    logger('info', `已挂载 v${VERSION}（会话 ${chatByConversation.size}，备份 ${listBackups(backupDirectory(db.file)).length} 份）`);
    // ── 释放 ────────────────────────────────────────────────────────────────────
    const disposeAll = () => {
        if (!active)
            return;
        active = false;
        webDisposer?.();
        if (outboxTimer !== null) {
            clearInterval(outboxTimer);
            outboxTimer = null;
        }
        if (backupTimer !== null) {
            clearInterval(backupTimer);
            backupTimer = null;
        }
        scheduler.stop();
        background.stop();
        if (typeof commandDisposer === 'function')
            commandDisposer();
        void queue.close();
        void background.drain(1500);
        db.close();
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => disposeAll, 'companion-memory: lifecycle');
    }
}
export default apply;
//# sourceMappingURL=index.js.map