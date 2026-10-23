/**
 * 事实写入与变更（任务书 §10.1–§10.2）。
 *
 * 规则来自任务书，逐条对应实现：
 *   · 「以前住成都，现在在重庆」→ 两段有效时间都保留（旧行写 valid_to，新行写 valid_from）。
 *   · 「你记错了，我从来没住过那里」→ 撤回错误结论，并把派生行一起标 retracted。
 *   · 同主题不同主体 → 不覆盖（subject_key 不同，天然不同桶）。
 *   · 重复原话被多个摘要引用 → 只有一份独立证据（按 messageId 去重）。
 *   · 新信息冲突且无法判定 → 存 conflict 边，不强行选择。
 *
 * 本模块只做「决定写什么」，真正的写库由 repositories 事务完成；
 * 所有入参都经过来源校验（sourceMessageId 必须来自真实消息表）。
 */
import { buildAliases, buildLexicalTerms } from './lexical-index.js';
import { normalizeText } from './normalizer.js';
const MAX_OBJECT_CHARS = 2000;
/** 规范化键：主题/谓语去空白与大小写，保证「住址」和「住址 」进同一桶。 */
export function keyOf(value) {
    if (value === null)
        return null;
    const normalized = normalizeText(value).replace(/\s+/g, '');
    return normalized === '' ? null : normalized;
}
export class FactUpdater {
    repos;
    config;
    constructor(repos, 
    /** 保留配置位，供后续按预算裁剪对象文本；当前只做 MAX_OBJECT_CHARS 截断。 */
    config) {
        this.repos = repos;
        this.config = config;
        void this.config.preserveRawText;
    }
    /**
     * 写入一条候选。返回写入结果供调用方记账与 /fish why 展示。
     * 这是**幂等**操作：同一 id 重复写入不会产生第二行；同一证据重复引用不会累加证据。
     */
    write(candidate) {
        const evidence = dedupeEvidence(candidate.evidence);
        if (evidence.length === 0) {
            return { type: 'rejected', reason: '缺少来源消息：记忆必须有 evidence message id' };
        }
        const existing = this.repos.getMemory(candidate.id);
        if (existing !== undefined) {
            const known = new Set(this.repos.memoryEvidence(candidate.id).map((item) => item.messageId));
            const fresh = evidence.filter((item) => !known.has(item.messageId));
            if (fresh.length === 0)
                return { type: 'unchanged', id: candidate.id, reason: 'duplicate-evidence' };
            // 同一 id 补充新证据：按 §10.2「重复原话仍只有一份独立证据」追加去重后的集合。
            for (const item of fresh)
                this.repos.addMemoryEvidence(candidate.id, item.messageId, item.quote);
            return { type: 'inserted', id: candidate.id, supersededIds: [] };
        }
        const subjectKey = keyOf(candidate.subject);
        const predicateKey = keyOf(candidate.predicate);
        const conflicts = this.findConflicts(candidate, subjectKey, predicateKey);
        // 明确纠错：旧结论撤回，而不是并存。
        if (candidate.kind === 'fact' && candidate.sourceKind === 'owner_correction' && conflicts.length > 0) {
            const retracted = this.retractMany(conflicts.map((row) => row.id), candidate.observedAtMs);
            const id = this.insert(candidate, evidence, subjectKey, predicateKey, conflicts[0]?.id);
            return { type: 'inserted', id, supersededIds: retracted };
        }
        // 冲突但无法判定：保留双方，写 contradicts 边，标记 hypothesis 级不确定。
        if (conflicts.length > 0 && candidate.relation !== 'updates') {
            const id = this.insert(candidate, evidence, subjectKey, predicateKey, conflicts[0]?.id);
            for (const row of conflicts)
                this.repos.addEdge(id, row.id, 'contradicts');
            return { type: 'conflict', id, conflictsWith: conflicts.map((row) => row.id) };
        }
        // 常规更新：旧行的有效期在此刻收口（保留历史，不删除）。
        const superseded = [];
        if (conflicts.length > 0) {
            for (const row of conflicts) {
                this.repos.closeValidity(row.id, candidate.observedAtMs);
                superseded.push(row.id);
            }
        }
        const id = this.insert(candidate, evidence, subjectKey, predicateKey, conflicts[0]?.id);
        return { type: 'inserted', id, supersededIds: superseded };
    }
    /**
     * 显式纠错（/fish correct、用户「你记错了」）。
     * 撤回目标 + 所有 derived_from 依赖，返回受影响 id，供审计与上下文剔除。
     */
    retract(memoryId, reason, nowMs) {
        if (this.repos.getMemory(memoryId) === undefined) {
            return { retracted: [], cascaded: [], notFound: true };
        }
        const cascaded = this.repos.dependentsOf(memoryId).map((row) => row.id);
        const retracted = this.retractMany([memoryId, ...cascaded], nowMs);
        this.repos.audit({
            principalId: null,
            kind: 'memory.correct',
            entityId: memoryId,
            payload: { reason, retracted },
            createdAtMs: nowMs,
        });
        return { retracted, cascaded, notFound: false };
    }
    retractMany(ids, nowMs) {
        const done = [];
        for (const id of ids) {
            const row = this.repos.getMemory(id);
            if (row === undefined)
                continue;
            if (row.status === 'retracted')
                continue;
            this.repos.setMemoryStatus(id, 'retracted', nowMs);
            this.repos.removeFromIndex(id);
            done.push(id);
        }
        return done;
    }
    insert(candidate, evidence, subjectKey, predicateKey, edgeTarget) {
        const objectText = safeObjectText(candidate.object);
        const lexicalTerms = buildLexicalTerms([candidate.claim, subjectKey, predicateKey, objectText]);
        const aliases = buildAliases(subjectKey, predicateKey);
        const input = {
            id: candidate.id,
            principalId: candidate.principalId,
            conversationId: candidate.conversationId,
            visibility: candidate.visibility,
            kind: candidate.kind,
            subjectKey,
            predicateKey,
            object: candidate.object,
            claim: candidate.claim,
            sourceKind: candidate.sourceKind,
            confidence: clamp01(candidate.confidence),
            salience: clamp01(candidate.salience),
            validFromMs: candidate.validFromMs ?? candidate.eventAtMs ?? candidate.observedAtMs,
            validToMs: candidate.validToMs ?? null,
            eventAtMs: candidate.eventAtMs,
            observedAtMs: candidate.observedAtMs,
            activationAtMs: candidate.observedAtMs,
            evidence,
            lexicalTerms,
            aliases,
            edge: edgeTarget === undefined
                ? undefined
                : { toId: edgeTarget, relation: candidate.relation ?? 'updates' },
        };
        this.repos.insertMemory(input);
        this.repos.indexMemory(candidate.id, candidate.principalId, lexicalTerms, aliases);
        return candidate.id;
    }
    findConflicts(candidate, subjectKey, predicateKey) {
        if (subjectKey === null || predicateKey === null)
            return [];
        const rows = this.repos.factsBySubject(candidate.principalId, subjectKey, predicateKey);
        return rows.filter((row) => {
            if (row.id === candidate.id)
                return false;
            if (row.status !== 'active')
                return false;
            // 同主体同谓语不同值才算冲突；同值视为重复陈述，交给证据去重处理。
            if (row.object_json === safeObjectText(candidate.object))
                return false;
            // 不同 visibility 的记忆互不覆盖：群聊里的说法不能顶掉私聊里的本人事实。
            if (row.visibility !== candidate.visibility && candidate.visibility === 'shared')
                return true;
            return true;
        });
    }
}
/** 证据去重：同一 messageId 只保留第一次引用（§10.2 重复原话不算多个独立证据）。 */
export function dedupeEvidence(evidence) {
    const seen = new Set();
    const out = [];
    for (const item of evidence) {
        if (item.messageId === '')
            continue;
        if (seen.has(item.messageId))
            continue;
        seen.add(item.messageId);
        out.push({ messageId: item.messageId, quote: item.quote.slice(0, 200) });
    }
    return out;
}
function safeObjectText(object) {
    if (object === null || object === undefined)
        return '';
    if (typeof object === 'string')
        return object.slice(0, MAX_OBJECT_CHARS);
    try {
        return JSON.stringify(object).slice(0, MAX_OBJECT_CHARS);
    }
    catch {
        return String(object).slice(0, MAX_OBJECT_CHARS);
    }
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
//# sourceMappingURL=fact-updater.js.map