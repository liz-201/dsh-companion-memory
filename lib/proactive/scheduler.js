import { buildCandidates, startOfDayMs } from './candidate-builder.js';
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js';
function hashText(text) {
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= BigInt(text.charCodeAt(index));
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(36);
}
function str(row, key) {
    const value = row[key];
    return typeof value === 'string' ? value : null;
}
function num(row, key) {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export class ProactiveScheduler {
    options;
    now;
    timer = null;
    scanning = false;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }
    get running() {
        return this.timer !== null;
    }
    /** 启动周期扫描；重复调用不会产生第二个 timer（热重载安全）。 */
    start() {
        if (this.timer !== null)
            return;
        const intervalMs = Math.max(60_000, this.options.config.proactive.checkMinutes * 60_000);
        this.timer = setInterval(() => {
            void this.scan().catch(error => {
                this.options.log?.('warn', `主动扫描失败：${error instanceof Error ? error.message : String(error)}`);
            });
        }, intervalMs);
        // 不让定时器把进程钉住：卸载/退出时能自然结束。
        if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
            this.timer.unref();
        }
    }
    stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** 单次扫描。测试直接调它，不依赖真实时间。 */
    async scan(nowMs = this.now()) {
        const { metrics, log } = this.options;
        const result = {
            scanned: 0,
            gatesBlocked: 0,
            candidates: 0,
            generated: 0,
            enqueued: 0,
            skipped: [],
        };
        if (this.scanning)
            return result;
        this.scanning = true;
        try {
            await this.options.beforeScan?.(nowMs);
            const conversations = this.options.listConversations();
            for (const conversation of conversations) {
                result.scanned += 1;
                try {
                    await this.scanOne(conversation, nowMs, result);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    result.skipped.push({ conversationId: conversation.conversationId, reason: `error:${message}` });
                    metrics.degrade(`主动扫描失败：${message}`);
                    log?.('warn', `主动扫描会话失败 ${conversation.conversationId}: ${message}`);
                }
            }
            return result;
        }
        finally {
            this.scanning = false;
        }
    }
    async scanOne(conversation, nowMs, result) {
        const { config, repos, metrics, log } = this.options;
        void repos;
        const conversationId = conversation.conversationId;
        const last = repos.db.get(`SELECT * FROM outbox WHERE conversation_id = ? AND ${SPONTANEOUS_OUTBOX} AND status IN ('sent','unknown') ORDER BY planned_at_ms DESC LIMIT 1`, conversationId);
        const lastPlanned = last === undefined ? undefined : num(last, 'planned_at_ms') ?? undefined;
        const lastStatus = last === undefined ? undefined : str(last, 'status');
        // 只有「已经发出去过」的消息才计入冷却；被取消的不算。
        const lastProactiveAtMs = lastPlanned !== undefined && (lastStatus === 'sent' || lastStatus === 'unknown')
            ? lastPlanned
            : undefined;
        const built = buildCandidates({
            config,
            repos,
            conversationId,
            principalId: conversation.principalId,
            nowMs,
            mainTurnInFlight: this.options.mainTurnInFlight?.(conversationId) ?? false,
            lastProactiveAtMs,
            grievance: conversation.grievance,
            affection: conversation.affection,
            unresolvedConflict: conversation.unresolvedConflict,
        });
        if (!built.gate.ok) {
            result.gatesBlocked += 1;
            result.skipped.push({ conversationId, reason: built.gate.blocked.join(',') });
            return;
        }
        result.candidates += built.candidates.length;
        if (built.selected === null) {
            result.skipped.push({ conversationId, reason: 'no-candidate' });
            return;
        }
        const candidate = built.selected;
        const budget = Math.max(0, config.proactive.maxGenerationCallsPerCandidate);
        if (budget === 0 && candidate.kind !== 'reminder') {
            result.skipped.push({ conversationId, reason: 'generation-budget-zero' });
            return;
        }
        const expectedInboundSeq = repos.latestInboundSeq(conversationId);
        let content;
        if (candidate.kind === 'reminder') {
            // 提醒是明确约定：不靠模型复述，避免被性格改写成不准确的说法（§14.5）。
            content = `提醒你一件事：${candidate.topic}`;
        }
        else {
            content = await this.safeGenerate(candidate, conversation);
            result.generated += 1;
        }
        if (content === null || content.trim().length === 0) {
            result.skipped.push({ conversationId, reason: 'generation-empty' });
            return;
        }
        const prepared = this.options.prepare ? await this.options.prepare(conversationId, content, expectedInboundSeq, candidate.key) : content;
        if (!prepared) {
            result.skipped.push({ conversationId, reason: 'expression-or-target-unavailable' });
            return;
        }
        const text = prepared.trim();
        if (text.length > 1000) {
            result.skipped.push({ conversationId, reason: 'generated-content-too-long' });
            return;
        }
        const outboxId = `ob_${hashText(`${candidate.key}:${nowMs}`)}`;
        const enqueued = repos.enqueueOutbox({
            id: outboxId,
            conversationId,
            turnId: null,
            candidateKey: candidate.key,
            taskId: candidate.taskId,
            content: text,
            contentHash: hashText(text),
            plannedAtMs: nowMs,
            expectedInboundSeq: candidate.kind === 'reminder' ? null : expectedInboundSeq,
        });
        if (enqueued.inserted) {
            repos.db.run("UPDATE proactive_opportunities SET status = 'selected' WHERE id = ?", candidate.key);
            repos.db.run('UPDATE outbox SET opportunity_id = ?, persona_id = ?, origin_device_id = ? WHERE id = ?', candidate.key, repos.getSetting(`persona.id:${conversation.principalId}`) ?? 'builtin', repos.getSetting('local.device-id') ?? '', outboxId);
            result.enqueued += 1;
            metrics.count('proactive.enqueued', 1);
            repos.audit({
                principalId: conversation.principalId,
                kind: 'proactive-enqueued',
                entityId: outboxId,
                payload: { candidate: candidate.key, kind: candidate.kind, reasons: candidate.reasons },
                createdAtMs: nowMs,
            });
        }
        else {
            result.skipped.push({ conversationId, reason: 'duplicate-candidate' });
        }
        // 日限额统计用：扫描时顺带算一次，便于日志核对（不写入）。
        const sentToday = repos.countOutboxSince(conversationId, startOfDayMs(nowMs, config.proactive.timezone));
        log?.('debug', `主动扫描 ${conversationId}: candidate=${candidate.kind} 今日=${sentToday}`);
    }
    async safeGenerate(candidate, conversation) {
        try {
            return await this.options.generate({ candidate, conversation });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.metrics.degrade(`主动生成失败：${message}`);
            this.options.log?.('warn', `主动生成失败：${message}`);
            return null;
        }
    }
}
//# sourceMappingURL=scheduler.js.map