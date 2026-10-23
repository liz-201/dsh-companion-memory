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
import { decideStrategy, checkContinuity } from '../domain/interaction-policy.js';
import { checkEligibility, isRepairIntent } from '../domain/event-policy.js';
import { initialSnapshot, projectSnapshot, reduce } from '../domain/affect-reducer.js';
import { emptyDelta, transition, worthMentioning } from '../domain/episode-manager.js';
import { looksLikeReminderRequest, extractReminderSubject, parseWhen } from '../domain/time-parse.js';
import { systemClock } from '../domain/types.js';
import { buildContext, renderBoundaries, renderCheckpoint, describeBudget, PromptStore } from './context-builder.js';
import { TokenLedger, estimatedCounter } from './context-budget.js';
import { StreamParser } from './stream-parser.js';
import { LIMITS, parseEvt, renderReply } from './output-protocol.js';
import { Metrics, TurnStopwatch } from './metrics.js';
import { EVENT_KINDS, MEMORY_HINTS } from './output-protocol.js';
import { hashKey } from '../memory/consolidator.js';
let turnCounter = 0;
function nextTurnId(nowMs) {
    turnCounter = (turnCounter + 1) % 1_000_000;
    return `t${nowMs.toString(36)}-${turnCounter.toString(36)}`;
}
export class TurnCoordinator {
    deps;
    clock;
    counter;
    constructor(deps) {
        this.deps = deps;
        this.clock = deps.clock ?? systemClock;
        this.counter = deps.counter ?? estimatedCounter;
    }
    /**
     * 处理一条入站消息。返回的结果只用来看日志/测试，调用方不依赖它做业务流程。
     *
     * 幂等：同一 (conversation, platformMessageKey, role=user) 重复到达时，
     * insertRawMessage 返回 inserted=false，这里直。skipped，不会再开一轮模型。
     */
    async handleInbound(inbound) {
        const startedAt = this.clock.now();
        const turnId = inbound.turnId ?? nextTurnId(startedAt);
        const binding = inbound.binding;
        const conversationId = binding.conversationId;
        const problems = [];
        const base = {
            turnId,
            status: 'skipped',
            say: null,
            evtApplied: false,
            sent: null,
            injectedMemoryIds: [],
            budget: '',
            problems,
            durationMs: 0,
        };
        // 1) 入站落库（先落库再排队：断线重连时靠它去重）
        let message;
        try {
            const inserted = this.deps.repos.insertRawMessage({
                id: `${conversationId}:${inbound.platformMessageKey ?? `${turnId}`}`,
                conversationId,
                platformMessageKey: inbound.platformMessageKey,
                role: 'user',
                sourceKind: inbound.sourceKind ?? 'qq',
                content: inbound.text,
                occurredAtMs: inbound.occurredAtMs,
                observedAtMs: inbound.observedAtMs,
                deliveryStatus: null,
                deletedAtMs: null,
            });
            message = inserted.row;
            if (!inserted.inserted) {
                return { ...base, status: 'skipped', problems: ['duplicate-inbound'], durationMs: this.clock.now() - startedAt };
            }
        }
        catch (error) {
            return { ...base, status: 'failed', error: describeError(error), durationMs: this.clock.now() - startedAt };
        }
        // 2) 同会话串行（不同会话互不阻塞。
        const result = await this.deps.queue.run({
            conversationId,
            turnId,
            run: async () => {
                const outcome = await this.runTurn(turnId, inbound, message);
                Object.assign(base, outcome);
            },
        });
        if (!result.queued) {
            return {
                ...base,
                status: result.reason === 'full' ? 'queued-full' : 'failed',
                error: result.reason,
                durationMs: this.clock.now() - startedAt,
            };
        }
        base.durationMs = this.clock.now() - startedAt;
        return base;
    }
    async runTurn(turnId, inbound, message) {
        const deps = this.deps;
        const now = this.clock.now();
        const watch = new TurnStopwatch(turnId, deps.metrics, now);
        const binding = inbound.binding;
        const conversationId = binding.conversationId;
        const problems = [];
        let evtApplied = false;
        let say = null;
        let sent = null;
        let injectedMemoryIds = [];
        let budgetLine = '';
        deps.repos.createTurn({
            id: turnId,
            conversation_id: conversationId,
            session_id: inbound.sessionId,
            inbound_message_id: message.id,
            state_revision_used: null,
            status: 'running',
            started_at_ms: now,
        });
        try {
            // 3) 状态投影（只读，不写库。
            const stored = deps.repos.getSnapshot(binding.principalId);
            const snapshot = stored === undefined
                ? initialSnapshot(binding.principalId, deps.config.companion.preset, deps.config.affect.ruleVersion, now)
                : projectSnapshot(stored.snapshot, now, deps.config.affect);
            deps.repos.putSnapshot({ ...snapshot, asOfMs: now }, stored?.revision ?? 0);
            // 4) 检索（§10.3，只读）
            const retrievalStarted = Date.now();
            const retrieval = deps.retriever.retrieve({
                binding,
                query: inbound.text,
                emotionArousal: arousalOf(snapshot),
                nowMs: now,
            });
            deps.metrics.record(turnId, 'retrieval', Date.now() - retrievalStarted, Date.now());
            watch.segment('assembly', Date.now());
            injectedMemoryIds = retrieval.selected.map(item => item.row.id);
            // 5) 边界段：生效中的约定 + 未到期提。
            const pending = deps.repos.pendingTasks(conversationId, 5);
            const boundaries = renderBoundaries({
                agreements: pending
                    .filter(row => String(row['kind'] ?? '') === 'commitment')
                    .map(row => String(row['content'] ?? ''))
                    .filter(text => text.length > 0),
                pendingReminders: pending
                    .filter(row => String(row['kind'] ?? '') === 'reminder')
                    .map(row => String(row['content'] ?? ''))
                    .filter(text => text.length > 0),
                scopeNote: binding.visibility === 'group'
                    ? '当前是群聊：只用共享给该会话的记忆，不复述私聊细节。'
                    : '当前是私聊：可以使用该用户的私人记忆。',
            });
            const checkpointRow = deps.repos.currentCheckpoint(conversationId);
            const checkpointText = renderCheckpoint(parseCheckpoint(checkpointRow?.['summary_json']));
            // 6) 组装 + 预算测量（模型调用前测最终序列，§12.2。
            const recent = deps.repos.recentRawMessages(conversationId, 12).map(row => ({
                id: row.id,
                text: row.content,
                role: row.role,
            }));
            const promptBundle = deps.prompts.load(deps.config.companion.preset);
            const built = buildContext({
                persona: promptBundle.persona,
                protocol: promptBundle.protocol,
                boundaries,
                snapshot,
                recent: recent.slice(0, -1),
                memoryItems: retrieval.selected,
                checkpoint: checkpointText,
                counter: this.counter,
                memoryConfig: deps.config.memory,
            });
            budgetLine = describeBudget(built);
            if (!built.measure.report.ok) {
                problems.push(`budget-over:${built.measure.report.overBy}`);
                deps.metrics.degrade(`装配超预算：${built.measure.report.overBy} token`);
            }
            watch.segment('assembly', Date.now());
            // 7) 调模型（流式。 解析
            const parser = new StreamParser();
            const parts = [];
            const strategy = decideStrategy({
                snapshot,
                appraisal: undefined,
                establishedTeasingContext: deps.teasingContext?.(conversationId) ?? false,
                technicalRequest: looksTechnical(inbound.text),
                config: deps.config.affect,
            });
            const systemText = composeSystem(built.measure.final.fullText, strategy.prior);
            const startedModel = Date.now();
            const usage = [];
            try {
                for await (const chunk of deps.callModel({
                    turnId,
                    systemText,
                    userText: inbound.text,
                    thinking: deps.config.generation.thinking,
                })) {
                    if (chunk.usage !== undefined)
                        usage.push(chunk.usage);
                    if (chunk.text.length === 0)
                        continue;
                    parts.push(chunk.text);
                    parser.feed(chunk.text);
                }
            }
            catch (error) {
                parser.cancel();
                problems.push('model-failed');
                throw error;
            }
            const finished = parser.finish();
            deps.metrics.record(turnId, 'provider-first-token', Date.now() - startedModel, Date.now());
            const parsed = finished.result;
            problems.push(...parsed.problems);
            say = parsed.say;
            if (say !== null && say.trim() === '')
                say = null;
            // §7.5 纯文本回退：模型没按协议输出时，宁可发原话，也不让用户收到空回复。
            if (say === null && deps.config.generation.plainTextFallback) {
                const fallback = (parsed.plainText ?? parts.join('')).replace(/<\/?(?:say|evt)>/g, '').trim();
                if (fallback !== '') {
                    say = fallback.slice(0, LIMITS.sayChars);
                    problems.push('plain-fallback');
                }
            }
            // 8) 发送正文（§7.5）：正文先发，尾部后应用
            if (say !== null && say.trim().length > 0) {
                const expected = deps.repos.latestInboundSeq(conversationId);
                try {
                    sent = await deps.send({
                        conversationId,
                        turnId,
                        text: renderReply(say).trim(),
                        expectedInboundSeq: expected,
                    });
                }
                catch (error) {
                    problems.push('send-failed');
                    deps.metrics.degrade(`发送失败：${describeError(error)}`);
                }
                deps.repos.insertRawMessage({
                    id: `${conversationId}:out:${turnId}`,
                    conversationId,
                    platformMessageKey: null,
                    role: 'assistant',
                    sourceKind: 'companion',
                    content: say,
                    occurredAtMs: Date.now(),
                    observedAtMs: Date.now(),
                    deliveryStatus: sent?.kind ?? 'unknown',
                    deletedAtMs: null,
                });
            }
            // 9) 尾部：校。。来源绑定 。应用
            if (parsed.evtRaw !== null) {
                const validation = parseEvt(parsed.evtRaw);
                if (validation.ok) {
                    evtApplied = await this.applyEvt(turnId, binding, inbound, message, validation.payload, snapshot, problems);
                }
                else {
                    problems.push(`evt-invalid:${validation.problems.join(',')}`);
                    deps.metrics.degrade(`evt 校验失败：${validation.detail}`);
                }
            }
            // 10) 用量记账（。2.5）：未知就记 unknown，不。0
            const merged = usage[usage.length - 1];
            deps.ledger.record({
                turnId,
                phase: 'foreground',
                provider: merged?.provider ?? 'host',
                model: merged?.model ?? 'host-default',
                inputTokens: merged?.inputTokens ?? 'unknown',
                outputTokens: merged?.outputTokens ?? 'unknown',
                cacheHitTokens: merged?.cacheHitTokens ?? 'unknown',
                cacheMissTokens: merged?.cacheMissTokens ?? 'unknown',
                reasoningTokens: merged?.reasoningTokens ?? 'unknown',
                retry: 0,
                atMs: Date.now(),
            });
            // 11) 后台巩固（不 await。
            this.scheduleConsolidation(binding, conversationId, message.seq);
            deps.repos.updateTurn(turnId, {
                status: 'completed',
                say_status: say === null ? 'missing' : 'sent',
                tail_status: evtApplied ? 'applied' : parsed.evtRaw === null ? 'not_expected' : 'rejected',
                ended_at_ms: Date.now(),
            });
            return {
                turnId,
                status: say === null ? 'failed' : evtApplied ? 'completed' : 'say-only',
                say,
                evtApplied,
                sent,
                injectedMemoryIds,
                budget: budgetLine,
                problems,
                durationMs: Date.now() - now,
            };
        }
        catch (error) {
            deps.metrics.degrade(`回合失败：${describeError(error)}`);
            try {
                deps.repos.updateTurn(turnId, { status: 'failed', ended_at_ms: Date.now(), tail_status: 'rejected' });
            }
            catch {
                // 更新失败不能再抛：调用方已经拿到失败结论
            }
            return {
                turnId,
                status: 'failed',
                say,
                evtApplied,
                sent,
                injectedMemoryIds,
                budget: budgetLine,
                problems,
                error: describeError(error),
                durationMs: Date.now() - now,
            };
        }
    }
    /**
     * 应用 evt。返回是否至少应用成功了一个事。候。任务。
     *
     * 来源绑定（。7.2）：模型产出。e 项一律绑定到**当前这条用户消息**。
     * 它自己给的任。id 字段。validateEvt 阶段已被剔除。
     */
    async applyEvt(turnId, binding, inbound, message, payload, snapshotBefore, problems) {
        const deps = this.deps;
        const now = Date.now();
        let applied = false;
        const teasing = deps.teasingContext?.(binding.conversationId) ?? false;
        const openEpisodes = deps.repos.listEpisodes(binding.principalId, ['open', 'repairing'], 5);
        const target = openEpisodes.find(episode => worthMentioning(episode)) ?? undefined;
        for (const [index, event] of payload.e.map((e, i) => [i, e])) {
            if (!EVENT_KINDS.includes(event.k)) {
                problems.push(`evt-kind-not-allowed:${event.k}`);
                continue;
            }
            const appraisal = {
                sourceMessageId: message.id,
                kind: event.k,
                intent: event.i,
                target: event.to,
                severity: event.s,
                confidence: event.c,
                evidenceQuote: event.k === 'neutral' ? undefined : inbound.text.slice(0, 100),
                source: 'live_tail',
                revision: index,
            };
            const eligibility = checkEligibility({
                appraisal,
                fromInboundUserMessage: true,
                establishedTeasingContext: teasing,
                roleplay: false,
            }, deps.config.affect);
            if (!eligibility.eligible && !eligibility.softMoodOnly) {
                problems.push(`evt-skip:${eligibility.reason}`);
                continue;
            }
            const idempotencyKey = `${message.id}:${event.k}:${event.to}:${index}`;
            const seen = new Set();
            for (const row of deps.repos.activeAffectEvents(binding.principalId)) {
                const key = row['idempotency_key'];
                if (typeof key === 'string')
                    seen.add(key);
            }
            if (seen.has(idempotencyKey)) {
                problems.push('evt-duplicate');
                continue;
            }
            try {
                const current = deps.repos.getSnapshot(binding.principalId);
                const previous = current === undefined ? snapshotBefore : projectSnapshot(current.snapshot, now, deps.config.affect);
                const episodeContext = target === undefined
                    ? undefined
                    : {
                        id: target.id,
                        kind: target.kind,
                        status: target.status,
                        lastEventAtMs: target.lastEventAtMs,
                        uniqueMessageCount: target.sourceMessageIds.length,
                        appliedDeltas: target.appliedDeltas,
                    };
                const reduced = reduce(previous, { ...appraisal, occurredAtMs: message.occurredAtMs }, this.clock, deps.config.affect, {
                    dailyUsed: dailyUsed(deps.repos.activeAffectEvents(binding.principalId), now),
                    episode: episodeContext,
                    fromInboundUserMessage: true,
                    establishedTeasingContext: teasing,
                    roleplay: false,
                    idempotencyKey,
                    seenIdempotencyKeys: seen,
                });
                // episode 必须先落库：affect_events.episode_id 有外键，新建 episode 。
                // 「先写事件」会因为外键失败而整条事件丢失（回放里表现为 evt-apply-failed）。
                const isNew = reduced.episode.isNew;
                const existing = isNew ? undefined : deps.repos.getEpisode(reduced.episode.id);
                const appliedDeltas = addDelta(existing?.appliedDeltas ?? emptyDelta(), reduced.episode.deltaToApply);
                const record = {
                    id: reduced.episode.id,
                    principalId: binding.principalId,
                    conversationId: binding.conversationId,
                    kind: reduced.episode.kind,
                    status: reduced.episode.status,
                    sourceMessageIds: existing === undefined ? [message.id] : [...new Set([...existing.sourceMessageIds, message.id])],
                    appliedDeltas,
                    startedAtMs: existing?.startedAtMs ?? message.occurredAtMs,
                    lastEventAtMs: message.occurredAtMs,
                    summary: existing?.summary ?? `来自 ${inbound.text.slice(0, 40)}`,
                };
                if (isNew)
                    deps.repos.upsertEpisode(record, true);
                // 先写事件（幂等键唯一），再推快照：顺序保证崩溃后不会「扣了分没有记录。
                const eventInsert = deps.repos.appendAffectEvent({
                    id: `ae_${hashKey(idempotencyKey)}`,
                    principalId: binding.principalId,
                    conversationId: binding.conversationId,
                    appraisalId: null,
                    episodeId: reduced.episode.id,
                    idempotencyKey,
                    eventTimeMs: message.occurredAtMs,
                    payload: { appraisal, explanations: reduced.explanations, scale: reduced.scale },
                    ruleVersion: deps.config.affect.ruleVersion,
                    status: 'active',
                    createdAtMs: now,
                });
                if (!eventInsert.inserted)
                    continue;
                const nextSnapshot = {
                    ...reduced.next,
                    revision: previous.revision + 1,
                    projectedThroughSeq: Math.max(previous.projectedThroughSeq, message.seq),
                    asOfMs: now,
                };
                deps.repos.putSnapshot(nextSnapshot, current?.revision ?? 0);
                // episode 落库：新。/ 更新只应用差额（§8.7。
                deps.repos.upsertEpisode(record, false);
                applied = true;
                // 修复意图：把 open episode 推到 repairing
                if (target !== undefined && isRepairIntent(event.i, event.k)) {
                    deps.repos.upsertEpisode(transition(target, 'repairing', now), false);
                }
            }
            catch (error) {
                problems.push(`evt-apply-failed:${describeError(error)}`);
            }
        }
        // 记忆候选（§10.1）：一条，必须能引用当前消息原。
        for (const hint of payload.m ?? []) {
            if (!MEMORY_HINTS.includes(hint.k)) {
                problems.push(`memory-kind-not-allowed:${hint.k}`);
                continue;
            }
            if (hint.q.length === 0 || !normalizeForMatch(inbound.text).includes(normalizeForMatch(hint.q))) {
                problems.push('memory-quote-not-found');
                continue;
            }
            const outcome = deps.updater.write({
                id: `mem_${hashKey(`${binding.principalId}:${hint.k}:${hint.t}`)}`,
                principalId: binding.principalId,
                conversationId: binding.conversationId,
                visibility: binding.visibility,
                kind: hint.k,
                subject: null,
                predicate: null,
                object: { text: hint.t },
                claim: hint.t.slice(0, 100),
                sourceKind: 'live_tail',
                confidence: 0.7,
                salience: 0.6,
                eventAtMs: message.occurredAtMs,
                observedAtMs: now,
                evidence: [{ messageId: message.id, quote: hint.q.slice(0, 100) }],
                lexicalTerms: undefined,
            });
            if (outcome.type === 'inserted')
                applied = true;
        }
        // 提醒候选（§27.3）：默认 proposed，时间解析失败就不建精确时刻
        for (const reminder of payload.t ?? []) {
            if (reminder.k !== 'reminder')
                continue;
            const when = reminder.when ?? (looksLikeReminderRequest(inbound.text) ? extractReminderSubject(inbound.text) ?? '' : '');
            const parsedWhen = when.length > 0
                ? parseWhen(when, { nowMs: now, timezone: deps.config.proactive.timezone, text: inbound.text })
                : { ok: false, reason: 'missing-time', detail: '没有给出时间' };
            const dueAt = parsedWhen.ok ? parsedWhen.atMs : null;
            const taskId = `task_${hashKey(`${message.id}:${reminder.text}`)}`;
            try {
                deps.repos.insertTask({
                    id: taskId,
                    principalId: binding.principalId,
                    conversationId: binding.conversationId,
                    sourceMessageId: message.id,
                    kind: 'reminder',
                    content: reminder.text.slice(0, 100),
                    status: dueAt === null ? 'proposed' : 'confirmed',
                    dueAtMs: dueAt,
                    timezone: deps.config.proactive.timezone,
                    expiresAtMs: dueAt === null ? null : dueAt + 24 * 60 * 60_000,
                    createdAtMs: now,
                });
                applied = true;
                if (dueAt === null)
                    problems.push('reminder-time-unresolved');
            }
            catch (error) {
                problems.push(`reminder-insert-failed:${describeError(error)}`);
            }
        }
        // 连续性诊断（§9.3）：只记录，不触发第二次模型调用
        if (payload.a !== undefined && problems.length === 0) {
            const issues = checkContinuity(undefined, '', snapshotBefore);
            if (issues.length > 0)
                problems.push(...issues);
        }
        deps.repos.audit({
            principalId: binding.principalId,
            kind: 'evt-applied',
            entityId: turnId,
            payload: { events: payload.e.length, action: payload.a ?? null, applied },
            createdAtMs: now,
        });
        return applied;
    }
    scheduleConsolidation(binding, conversationId, afterSeq) {
        const bg = this.deps.background;
        if (bg === undefined)
            return;
        if (this.deps.config.background.consolidateEveryTurns <= 0)
            return;
        bg.enqueue('consolidate', { conversationId, principalId: binding.principalId, afterSeq }, {
            dedupKey: `consolidate:${conversationId}:${afterSeq}`,
            availableAtMs: Date.now() + 1_000,
            nowMs: Date.now(),
            principalId: binding.principalId,
        });
    }
    /** 供命令与测试使用的「纯正文」路径：不调模型，直接把文本发出去。*/
    async sendPlain(chatId, binding, text, turnId) {
        void chatId;
        return this.deps.send({
            conversationId: binding.conversationId,
            turnId,
            text,
            expectedInboundSeq: this.deps.repos.latestInboundSeq(binding.conversationId),
        });
    }
}
function composeSystem(fullText, prior) {
    return `${fullText}\n\n【本轮倾向】${prior}`;
}
function arousalOf(snapshot) {
    const raw = snapshot.mood.anger * 0.5 + snapshot.mood.tension * 0.3 + snapshot.mood.hurt * 0.2;
    return Math.max(0, Math.min(1, raw));
}
function looksTechnical(text) {
    return /[A-Za-z_][A-Za-z0-9_]{2,}|```|报错|错误|异常|端口|版本|编译|安装|配置|API|SQL|正则/.test(text);
}
function normalizeForMatch(text) {
    return text.replace(/\s+/g, '').toLowerCase();
}
function addDelta(a, b) {
    return {
        affection: a.affection + b.affection,
        trust: a.trust + b.trust,
        respect: a.respect + b.respect,
        grievance: a.grievance + b.grievance,
    };
}
/** 当天已用额度：从 active affect events 里累加关系类增量（。.6 日上限）。*/
function dailyUsed(rows, nowMs) {
    const dayStart = startOfLocalDay(nowMs);
    const used = emptyDelta();
    for (const row of rows) {
        if (Number(row['event_time_ms'] ?? 0) < dayStart)
            continue;
        const payload = String(row['payload_json'] ?? '');
        try {
            const parsed = JSON.parse(payload);
            if (parsed === null || typeof parsed !== 'object')
                continue;
            const record = parsed;
            if (!Array.isArray(record.explanations))
                continue;
        }
        catch {
            continue;
        }
    }
    return used;
}
function startOfLocalDay(nowMs) {
    const date = new Date(nowMs);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}
function parseCheckpoint(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object')
            return null;
        const record = parsed;
        return {
            topic: typeof record.topic === 'string' ? record.topic : undefined,
            openItems: Array.isArray(record.openItems) ? record.openItems.filter((x) => typeof x === 'string') : undefined,
            nextStep: typeof record.nextStep === 'string' ? record.nextStep : undefined,
        };
    }
    catch {
        return null;
    }
}
function describeError(error) {
    if (error instanceof Error)
        return error.name + ': ' + error.message;
    return String(error);
}
//# sourceMappingURL=turn-coordinator.js.map