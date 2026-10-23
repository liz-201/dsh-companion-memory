/**
 * 后台记忆巩固（任务书 §10.5、§11.4）。
 *
 * 关键约束：后台模型**只能产出结构化变更**，不能写 SQL、不能改人格/关系/权限、
 * 不能删除无关原文。所有变更都要过 schema 校验 + 来源校验 + repository 事务。
 *
 * 这里把「选料」与「应用」分开：
 *   · planBatch：从原始消息里挑出值得处理的增量（去重、筛选、限 2000 token），带上游标。
 *   · applyPlan：校验模型返回的变更并落库，未处理范围返回游标供下次继续。
 */
import { dedupeEvidence, FactUpdater, keyOf } from './fact-updater.js';
import { estimateTokens } from '../runtime/context-budget.js';
const MIN_MESSAGE_TOKENS = 8;
const ROLE_WEIGHT = {
    user: 3,
    assistant: 2,
    internal: 0.5,
    tool: 0.5,
};
/** 可能含可提炼内容的粗判：明确陈述、边界、约定。低权角色只在命中时才占预算。 */
const STATEMENT_RE = /(我喜欢|我不喜欢|我讨厌|我叫|我住|我要|我需要|我习惯|以后|记住|别忘了|不要|不许|提醒我|明天|后天|今天|几点)/u;
/**
 * 选料：去重、丢噪声、按重要度与时间排序后装进预算。
 *
 * 重要度不是关键词打分器，而是「这条消息里有没有可提炼的内容」的粗判：
 * 明确陈述（我喜欢/我不喜欢/以后/记住/我叫）、边界（别/不要/不许）、约定（明天/几点）
 * 权重高；纯附和（嗯/好/哈哈）权重低。
 */
export class Consolidator {
    repos;
    config;
    updater;
    constructor(repos, config, updater) {
        this.repos = repos;
        this.config = config;
        this.updater = updater;
    }
    planBatch(input) {
        const limit = input.limit ?? 200;
        const rows = this.repos.rawMessagesAfter(input.conversationId, input.afterSeq, limit);
        const seen = new Set();
        const picked = [];
        let used = 0;
        let dropped = 0;
        let cursor = input.afterSeq;
        for (const row of rows) {
            cursor = Math.max(cursor, row.seq);
            if (row.deletedAtMs !== null)
                continue;
            const content = row.content.trim();
            if (content === '' || estimateTokens(content) < MIN_MESSAGE_TOKENS) {
                dropped += 1;
                continue;
            }
            const fingerprint = content.replace(/\s+/g, '').slice(0, 120);
            if (seen.has(fingerprint)) {
                dropped += 1;
                continue;
            }
            seen.add(fingerprint);
            if (ROLE_WEIGHT[row.role] <= 0.5 && !STATEMENT_RE.test(content)) {
                dropped += 1;
                continue;
            }
            const cost = estimateTokens(content) + 4;
            if (used + cost > this.config.inputLimitTokens) {
                // 不静默丢弃：把游标停在未处理处，下一批继续（§10.5）。
                cursor = row.seq - 1;
                break;
            }
            used += cost;
            picked.push({
                id: row.id,
                role: row.role,
                content: row.content,
                occurredAtMs: row.occurredAtMs,
                seq: row.seq,
            });
        }
        return {
            conversationId: input.conversationId,
            principalId: input.principalId,
            messages: picked,
            cursor,
            estimatedTokens: used,
            dropped,
        };
    }
    /**
     * 应用模型产出的结构化变更。
     * 任何一条不合规只拒绝**那一条**，不整批回滚——但会记录原因，供 /fish doctor 与审计。
     */
    applyPlan(batch, plan, nowMs) {
        const known = new Map(batch.messages.map((message) => [message.id, message]));
        const rejected = [];
        const touched = [];
        const maxChanges = 20;
        plan.changes.slice(0, maxChanges).forEach((change, index) => {
            const reason = validateChange(change, known);
            if (reason !== null) {
                rejected.push({ index, reason });
                return;
            }
            const message = known.get(change.sourceMessageIds[0] ?? '');
            if (message === undefined) {
                rejected.push({ index, reason: '来源消息不在本批' });
                return;
            }
            const candidate = {
                id: memoryIdFor(batch.principalId, change),
                principalId: batch.principalId,
                conversationId: batch.conversationId,
                visibility: this.repos.db.get('SELECT kind FROM conversations WHERE id = ?', batch.conversationId)?.kind === 'group' ? 'group' : 'private',
                kind: change.kind,
                subject: change.subject,
                predicate: change.predicate,
                object: change.object,
                claim: change.claim.trim().slice(0, 500),
                sourceKind: 'consolidation',
                confidence: clamp01(change.confidence),
                salience: clamp01(change.salience),
                eventAtMs: change.eventAtMs,
                observedAtMs: nowMs,
                evidence: dedupeEvidence(change.sourceMessageIds.map((id) => ({ messageId: id, quote: change.quote.slice(0, 200) }))),
                ...(change.relation === undefined ? {} : { relation: change.relation }),
            };
            const outcome = this.updater.write(candidate);
            if (outcome.type === 'rejected') {
                rejected.push({ index, reason: outcome.reason });
                return;
            }
            touched.push(candidate.id);
        });
        const nextCursor = plan.cursor !== null && plan.cursor !== undefined && Number.isFinite(plan.cursor)
            ? Math.min(Math.max(0, Math.trunc(plan.cursor)), batch.cursor)
            : batch.cursor;
        this.repos.audit({
            principalId: batch.principalId,
            kind: 'memory.consolidate',
            entityId: batch.conversationId,
            payload: { applied: touched.length, rejected: rejected.length, nextCursor },
            createdAtMs: nowMs,
        });
        return { applied: touched.length, rejected, nextCursor, touchedIds: touched };
    }
}
/** 校验单条变更；返回 null 表示通过。 */
export function validateChange(change, known) {
    if (typeof change !== 'object' || change === null)
        return '变更必须是对象';
    if (!['episode', 'fact', 'preference', 'interaction_rule', 'hypothesis'].includes(change.kind)) {
        return `未知记忆类型：${String(change.kind)}`;
    }
    if (typeof change.claim !== 'string' || change.claim.trim() === '')
        return 'claim 不能为空';
    if (change.claim.length > 500)
        return 'claim 超过 500 字';
    if (!Array.isArray(change.sourceMessageIds) || change.sourceMessageIds.length === 0) {
        return '缺少来源消息 id';
    }
    for (const id of change.sourceMessageIds) {
        if (!known.has(id))
            return `来源消息不在本批：${id}`;
        if (known.get(id)?.role !== 'user')
            return '用户事实必须有真实用户消息作为证据';
    }
    if (typeof change.quote !== 'string' || change.quote.trim() === '')
        return '缺少原话证据';
    // 证据必须是来源消息里真实出现的片段，防止模型编造引用。
    const source = known.get(change.sourceMessageIds[0] ?? '');
    if (source !== undefined && !normalizeQuote(source.content).includes(normalizeQuote(change.quote))) {
        return '证据片段未在来源消息中出现';
    }
    if (change.kind === 'fact' && (change.subject === null || change.predicate === null)) {
        return '事实类记忆必须给出 subject 与 predicate';
    }
    if (change.kind === 'preference' && change.subject === null)
        return '偏好必须指出主体';
    if (change.kind === 'hypothesis' && change.confidence > 0.6)
        return '假设型记忆置信不得超过 0.6';
    return null;
}
function normalizeQuote(text) {
    return text.replace(/[\s，。！？、；：""''（）…—～,.!?;:'"()]/g, '').toLowerCase();
}
export function memoryIdFor(principalId, change) {
    const parts = [principalId, change.kind, keyOf(change.subject) ?? '-', keyOf(change.predicate) ?? '-', stableKey(change.object)];
    return 'mem_' + hashKey(parts.join('|'));
}
function stableKey(value) {
    if (value === null || value === undefined)
        return '-';
    if (typeof value === 'string')
        return value.slice(0, 80);
    try {
        return JSON.stringify(value).slice(0, 80);
    }
    catch {
        return '-';
    }
}
/** 稳定的短哈希（FNV-1a 64 位转 base36），不依赖 crypto 的随机性。 */
export function hashKey(input) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= BigInt(input.charCodeAt(i));
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(36).padStart(13, '0');
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
//# sourceMappingURL=consolidator.js.map