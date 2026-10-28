/**
 * 仓储层（任务书 §5.2 / §6.3）。
 *
 * 所有 SQL 集中在这里，其他模块只调用方法。几条硬约束：
 *   - 写操作一律带幂等键或唯一约束，重复调用不会重复扣分；
 *   - affect snapshot 用「期望 revision」做乐观并发，冲突直接抛错由队列重试；
 *   - FTS 是派生索引：记忆状态变化时同步维护，不允许只改 memories 不改 FTS。
 */
import { detectSourceKind, humanSourceSql, isHumanMessage } from '../memory/source-policy.js';
import { escapeLike, tokensToMatchQuery } from '../memory/normalizer.js';
import { SPONTANEOUS_OUTBOX } from './outbox-policy.js';
const json = (value) => JSON.stringify(value);
const parse = (text, fallback) => {
    if (typeof text !== 'string' || text === '')
        return fallback;
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
};
export class Repositories {
    db;
    constructor(db) {
        this.db = db;
    }
    // ---------- companion / principal / conversation ----------
    ensureCompanion(id, name, personality, nowMs) {
        this.db.run(`INSERT INTO companions (id, name, personality_json, created_at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`, id, name, json(personality), nowMs);
    }
    ensurePrincipal(id, companionId, botAccountId, userId, nowMs) {
        this.db.run(`INSERT INTO principals (id, companion_id, bot_account_id, user_id, created_at_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`, id, companionId, botAccountId, userId, nowMs);
        const row = this.db.get('SELECT * FROM principals WHERE id = ?', id);
        if (row === undefined)
            throw new Error(`principal ${id} 写入后仍读不到`);
        return row;
    }
    ensureConversation(id, principalId, kind, platformConversationId, nowMs) {
        this.db.run(`INSERT INTO conversations (id, principal_id, kind, platform_conversation_id, latest_inbound_seq, enabled)
       VALUES (?, ?, ?, ?, 0, 1)
       ON CONFLICT(id) DO NOTHING`, id, principalId, kind, platformConversationId);
        const row = this.db.get('SELECT * FROM conversations WHERE id = ?', id);
        if (row === undefined)
            throw new Error(`conversation ${id} 写入后仍读不到`);
        void nowMs;
        return row;
    }
    setActiveSession(conversationId, sessionId) {
        this.db.run('UPDATE conversations SET active_session_id = ? WHERE id = ?', sessionId, conversationId);
    }
    setConversationEnabled(conversationId, enabled) {
        this.db.run('UPDATE conversations SET enabled = ? WHERE id = ?', enabled ? 1 : 0, conversationId);
    }
    // ---------- raw messages ----------
    /**
     * 插入原始消息。同一 (conversation, platform key, role) 重复到达时返回既有行，
     * 上层据此判定「这条已经处理过」，不会启动第二个回复回合。
     */
    insertRawMessage(message) {
        if (message.platformMessageKey !== null) {
            const existing = this.db.get('SELECT * FROM raw_messages WHERE conversation_id = ? AND platform_message_key = ? AND role = ?', message.conversationId, message.platformMessageKey, message.role);
            if (existing !== undefined)
                return { row: toRawMessage(existing), inserted: false };
        }
        else {
            const existing = this.db.get('SELECT * FROM raw_messages WHERE id = ?', message.id);
            if (existing !== undefined)
                return { row: toRawMessage(existing), inserted: false };
        }
        this.db.run(`INSERT INTO raw_messages
       (id, conversation_id, platform_message_key, role, source_kind, content, occurred_at_ms, observed_at_ms, delivery_status, deleted_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, message.id, message.conversationId, message.platformMessageKey, message.role, detectSourceKind(message.content, message.sourceKind), message.content, message.occurredAtMs, message.observedAtMs, message.deliveryStatus, message.deletedAtMs);
        if (isHumanMessage(message)) {
            this.db.run(`UPDATE conversations
         SET latest_inbound_seq = (SELECT MAX(seq) FROM raw_messages WHERE conversation_id = ? AND role = 'user')
         WHERE id = ?`, message.conversationId, message.conversationId);
        }
        const stored = this.db.get('SELECT * FROM raw_messages WHERE id = ?', message.id);
        if (stored === undefined)
            throw new Error(`raw message ${message.id} 写入后仍读不到`);
        return { row: toRawMessage(stored), inserted: true };
    }
    getRawMessage(id) {
        const row = this.db.get('SELECT * FROM raw_messages WHERE id = ?', id);
        return row === undefined ? undefined : toRawMessage(row);
    }
    recentRawMessages(conversationId, limit, beforeSeq) {
        const rows = beforeSeq === undefined
            ? this.db.all('SELECT * FROM raw_messages WHERE conversation_id = ? AND deleted_at_ms IS NULL ORDER BY seq DESC LIMIT ?', conversationId, limit)
            : this.db.all('SELECT * FROM raw_messages WHERE conversation_id = ? AND deleted_at_ms IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?', conversationId, beforeSeq, limit);
        return rows.map(toRawMessage).reverse();
    }
    /**
     * 巩固用增量：seq 大于 afterSeq 的真实消息，按时间正序。
     * 与 recentRawMessages 不同，这里**不反转**，且把删除行也带上——调用方需要
     * 用 deleted_at_ms 判断跳过后仍推进游标（否则游标会被删除行永久卡住）。
     */
    rawMessagesAfter(conversationId, afterSeq, limit) {
        return this.db
            .all('SELECT * FROM raw_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', conversationId, afterSeq, limit)
            .map(toRawMessage);
    }
    latestInboundSeq(conversationId) {
        const row = this.db.get(`SELECT MAX(seq) AS seq FROM raw_messages WHERE conversation_id = ? AND ${humanSourceSql()}`, conversationId);
        return Number(row?.seq ?? 0);
    }
    softDeleteMessage(id, nowMs) {
        this.db.run('UPDATE raw_messages SET deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL', nowMs, id);
    }
    // ---------- turns ----------
    createTurn(turn) {
        this.db.run(`INSERT INTO turns (id, conversation_id, session_id, inbound_message_id, state_revision_used, status, say_status, tail_status, started_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, turn.id, turn.conversation_id, turn.session_id, turn.inbound_message_id, turn.state_revision_used, turn.status, turn.sayStatus ?? 'not_generated', turn.tailStatus ?? 'not_expected', turn.started_at_ms);
    }
    updateTurn(turnId, patch) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined)
                continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (fields.length === 0)
            return;
        values.push(turnId);
        this.db.run(`UPDATE turns SET ${fields.join(', ')} WHERE id = ?`, ...values);
    }
    getTurn(id) {
        return this.db.get('SELECT * FROM turns WHERE id = ?', id);
    }
    // ---------- appraisals ----------
    insertAppraisal(input) {
        this.db.run(`INSERT INTO appraisals
       (id, source_message_id, revision, kind, intent, target, severity, confidence, evidence_quote, producer, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_message_id, kind, target, revision) DO NOTHING`, input.id, input.sourceMessageId, input.revision, input.kind, input.intent, input.target, input.severity, input.confidence, input.evidenceQuote, input.producer, input.status, input.createdAtMs);
    }
    setAppraisalStatus(id, status) {
        this.db.run('UPDATE appraisals SET status = ? WHERE id = ?', status, id);
    }
    listAppraisalsForSource(sourceMessageId) {
        return this.db.all('SELECT * FROM appraisals WHERE source_message_id = ? ORDER BY revision', sourceMessageId);
    }
    // ---------- affect ----------
    getSnapshot(principalId) {
        const row = this.db.get('SELECT * FROM affect_snapshots WHERE principal_id = ?', principalId);
        if (row === undefined)
            return undefined;
        return {
            snapshot: parse(row.state_json, {
                principalId,
                revision: row.revision,
                projectedThroughSeq: row.projected_through_seq,
                asOfMs: row.as_of_ms,
                personality: { irritability: 0.5, sensitivity: 0.5, directness: 0.5, selfControl: 0.5, warmth: 0.5, initiative: 0.5 },
                relationship: { affection: 0, trust: 0, respect: 0, familiarity: 0, grievance: 0 },
                mood: { anger: 0, hurt: 0, joy: 0, tension: 0, expressiveness: 0 },
                openEpisodeIds: [],
                ruleVersion: row.rule_version,
            }),
            revision: row.revision,
            projectedThroughSeq: row.projected_through_seq,
        };
    }
    /** 乐观并发：数据库里的 revision 必须等于 expected，否则抛冲突。 */
    putSnapshot(snapshot, expectedRevision) {
        const existing = this.db.get('SELECT revision FROM affect_snapshots WHERE principal_id = ?', snapshot.principalId);
        if (existing !== undefined && existing.revision !== expectedRevision) {
            throw new Error(`affect snapshot 版本冲突：期望 ${expectedRevision}，实际 ${existing.revision}`);
        }
        this.db.run(`INSERT INTO affect_snapshots (principal_id, revision, projected_through_seq, as_of_ms, state_json, rule_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal_id) DO UPDATE SET
         revision = excluded.revision,
         projected_through_seq = excluded.projected_through_seq,
         as_of_ms = excluded.as_of_ms,
         state_json = excluded.state_json,
         rule_version = excluded.rule_version`, snapshot.principalId, snapshot.revision, snapshot.projectedThroughSeq, snapshot.asOfMs, json(snapshot), snapshot.ruleVersion);
    }
    /**
     * 追加 affect event。idempotency_key 唯一：重复投递返回既有行且 inserted=false，
     * 保证「同一条消息重放两次」不会扣两次分。
     */
    appendAffectEvent(input) {
        const existing = this.db.get('SELECT seq FROM affect_events WHERE idempotency_key = ?', input.idempotencyKey);
        if (existing !== undefined)
            return { seq: existing.seq, inserted: false };
        this.db.run(`INSERT INTO affect_events
       (id, principal_id, conversation_id, appraisal_id, episode_id, idempotency_key, event_time_ms, payload_json, rule_version, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.id, input.principalId, input.conversationId, input.appraisalId, input.episodeId, input.idempotencyKey, input.eventTimeMs, json(input.payload), input.ruleVersion, input.status, input.createdAtMs);
        const row = this.db.get('SELECT seq FROM affect_events WHERE id = ?', input.id);
        return { seq: Number(row?.seq ?? 0), inserted: true };
    }
    countAffectEvents(principalId, sinceMs) {
        const row = this.db.get('SELECT COUNT(*) AS n FROM affect_events WHERE principal_id = ? AND event_time_ms >= ?', principalId, sinceMs);
        return Number(row?.n ?? 0);
    }
    activeAffectEvents(principalId) {
        return this.db.all(`SELECT e.* FROM affect_events e LEFT JOIN appraisals a ON a.id=e.appraisal_id LEFT JOIN raw_messages r ON r.id=COALESCE(a.source_message_id,CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.appraisal.sourceMessageId') END) LEFT JOIN conversations c ON c.id=r.conversation_id WHERE e.principal_id = ? AND e.status = 'active' AND (r.id IS NULL OR (c.principal_id=e.principal_id AND ${humanSourceSql('r')})) ORDER BY e.seq`, principalId);
    }
    /** 最近一条影响关系的事件（`/fish why` 用）。 */
    lastAffectEvent(principalId) {
        return this.db.get("SELECT * FROM affect_events WHERE principal_id = ? AND status = 'active' ORDER BY seq DESC LIMIT 1", principalId);
    }
    getAffectEvent(seq) {
        return this.db.get('SELECT * FROM affect_events WHERE seq = ?', seq);
    }
    /**
     * 撤回一条情感事件（§15.1 `correct`）。
     * 不直接改数值：标记 retracted 后由调用方重投影，历史保持可追溯。
     */
    retractAffectEvent(seq, reason) {
        const row = this.getAffectEvent(seq);
        if (!row)
            return false;
        this.db.run("UPDATE affect_events SET status = 'retracted' WHERE seq = ? AND status = 'active'", seq);
        this.audit({
            principalId: row['principal_id'] === null ? null : String(row['principal_id']),
            kind: 'affect.retract',
            entityId: String(seq),
            payload: { reason },
            createdAtMs: Date.now(),
        });
        return true;
    }
    // ---------- settings（插件自身的小型开关，§15.1 proactive on/off） ----------
    getSetting(key) {
        const row = this.db.get('SELECT value FROM plugin_settings WHERE key = ?', key);
        return row?.value;
    }
    setSetting(key, value, updatedAtMs) {
        this.db.run(`INSERT INTO plugin_settings (key, value, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`, key, value, updatedAtMs);
    }
    // ---------- episodes ----------
    upsertEpisode(record, isNew) {
        if (isNew) {
            this.db.run(`INSERT INTO relationship_episodes
         (id, principal_id, conversation_id, kind, status, source_message_ids_json, applied_deltas_json, started_at_ms, last_event_at_ms, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, record.principalId, record.conversationId, record.kind, record.status, json(record.sourceMessageIds), json(record.appliedDeltas), record.startedAtMs, record.lastEventAtMs, record.summary);
            return;
        }
        this.db.run(`UPDATE relationship_episodes
       SET status = ?, source_message_ids_json = ?, applied_deltas_json = ?, last_event_at_ms = ?, summary = ?
       WHERE id = ?`, record.status, json(record.sourceMessageIds), json(record.appliedDeltas), record.lastEventAtMs, record.summary, record.id);
    }
    listEpisodes(principalId, statuses, limit = 10) {
        const placeholders = statuses.map(() => '?').join(',');
        const rows = this.db.all(`SELECT * FROM relationship_episodes WHERE principal_id = ? AND status IN (${placeholders})
       ORDER BY last_event_at_ms DESC LIMIT ?`, principalId, ...statuses, limit);
        return rows.map(toEpisode);
    }
    getEpisode(id) {
        const row = this.db.get('SELECT * FROM relationship_episodes WHERE id = ?', id);
        return row === undefined ? undefined : toEpisode(row);
    }
    // ---------- memories ----------
    insertMemory(input) {
        this.db.transaction(() => {
            this.db.run(`INSERT INTO memories
         (id, principal_id, conversation_id, visibility, kind, subject_key, predicate_key, object_json, claim, source_kind,
          status, confidence, salience, valid_from_ms, valid_to_ms, event_at_ms, observed_at_ms, activation_at_ms, embedding_model_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, input.id, input.principalId, input.conversationId, input.visibility, input.kind, input.subjectKey, input.predicateKey, input.object === undefined || input.object === null ? null : json(input.object), input.claim, input.sourceKind, input.confidence, input.salience, input.validFromMs, input.validToMs, input.eventAtMs, input.observedAtMs, input.activationAtMs, input.observedAtMs);
            for (const evidence of input.evidence) {
                this.db.run('INSERT INTO memory_evidence (memory_id, message_id, quote) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', input.id, evidence.messageId, evidence.quote);
            }
            if (input.edge !== undefined) {
                this.db.run('INSERT INTO memory_edges (from_id, to_id, relation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', input.id, input.edge.toId, input.edge.relation);
            }
            this.indexMemory(input.id, input.principalId, input.lexicalTerms, input.aliases);
        });
    }
    /** FTS 写入失败不能让整条记忆写不进去：降级为 LIKE 检索并记录状态。 */
    indexMemory(memoryId, principalId, lexicalTerms, aliases) {
        try {
            this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', memoryId);
            this.db.run('INSERT INTO memory_fts (memory_id, principal_id, lexical_terms, aliases) VALUES (?, ?, ?, ?)', memoryId, principalId, lexicalTerms, aliases);
            return true;
        }
        catch {
            return false;
        }
    }
    removeFromIndex(memoryId) {
        try {
            this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', memoryId);
        }
        catch {
            // FTS 不可用时无需清理。
        }
    }
    setMemoryStatus(id, status, nowMs) {
        this.db.transaction(() => {
            this.db.run('UPDATE memories SET status = ? WHERE id = ?', status, id);
            if (status === 'active')
                return;
            if (status === 'archived') {
                this.db.run('UPDATE memories SET valid_to_ms = COALESCE(valid_to_ms, ?) WHERE id = ?', nowMs, id);
            }
            this.removeFromIndex(id);
        });
    }
    getMemory(id) {
        return this.db.get('SELECT * FROM memories WHERE id = ?', id);
    }
    memoryEvidence(memoryId) {
        return this.db
            .all('SELECT message_id, quote FROM memory_evidence WHERE memory_id = ?', memoryId)
            .map((row) => ({ messageId: row.message_id, quote: row.quote }));
    }
    /** FTS 检索；返回 id 与 bm25 分数（越小越相关）。FTS 不可用时返回 undefined。 */
    searchFts(principalId, matchQuery, limit) {
        if (matchQuery === '')
            return [];
        try {
            return this.db.all(`SELECT memory_fts.memory_id AS memory_id, bm25(memory_fts) AS rank
         FROM memory_fts
         JOIN memories m ON m.id = memory_fts.memory_id
         WHERE memory_fts MATCH ? AND memory_fts.principal_id = ?
           AND m.status = 'active'
         ORDER BY rank LIMIT ?`, matchQuery, principalId, limit).map((row) => ({ id: row.memory_id, rank: Number(row.rank) }));
        }
        catch {
            return undefined;
        }
    }
    /** LIKE 退化路径：FTS5 不可用或查询语法出问题时使用。 */
    searchLike(principalId, tokens, limit) {
        if (tokens.length === 0)
            return [];
        const clauses = tokens.slice(0, 8).map(() => 'claim LIKE ? ESCAPE \'\\\'');
        const params = [principalId, ...tokens.slice(0, 8).map((token) => `%${escapeLike(token)}%`)];
        const rows = this.db.all(`SELECT id FROM memories WHERE principal_id = ? AND status = 'active' AND (${clauses.join(' OR ')}) LIMIT ?`, ...params, limit);
        return rows.map((row, index) => ({ id: row.id, rank: index }));
    }
    activeMemories(principalId, kinds, limit) {
        if (kinds.length === 0)
            return [];
        const placeholders = kinds.map(() => '?').join(',');
        return this.db.all(`SELECT * FROM memories WHERE principal_id = ? AND status = 'active' AND kind IN (${placeholders})
       ORDER BY salience DESC, activation_at_ms DESC LIMIT ?`, principalId, ...kinds, limit);
    }
    allMemories(principalId, limit = 500) {
        return this.db.all('SELECT * FROM memories WHERE principal_id = ? ORDER BY created_at_ms DESC LIMIT ?', principalId, limit);
    }
    /** 同 subject+predicate 的活跃事实，用于「以前住成都，现在在重庆」。 */
    factsBySubject(principalId, subjectKey, predicateKey) {
        return this.db.all(`SELECT * FROM memories WHERE principal_id = ? AND subject_key = ? AND predicate_key = ? AND status = 'active'
       ORDER BY COALESCE(valid_from_ms, observed_at_ms) DESC`, principalId, subjectKey, predicateKey);
    }
    updateMemoryFields(id, patch) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined)
                continue;
            fields.push(`${key} = ?`);
            values.push(value);
        }
        if (fields.length === 0)
            return;
        values.push(id);
        this.db.run(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`, ...values);
    }
    /** 追加一条证据；重复引用同一 message_id 不累加（§10.2）。 */
    addMemoryEvidence(memoryId, messageId, quote) {
        this.db.run('INSERT INTO memory_evidence (memory_id, message_id, quote) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', memoryId, messageId, quote);
    }
    /** 写入记忆间关系边。 */
    addEdge(fromId, toId, relation) {
        this.db.run('INSERT INTO memory_edges (from_id, to_id, relation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', fromId, toId, relation);
    }
    /** 收口有效期：保留历史行，只标记「到此为止」。 */
    closeValidity(id, validToMs) {
        this.db.run('UPDATE memories SET valid_to_ms = ? WHERE id = ? AND valid_to_ms IS NULL', validToMs, id);
    }
    /** derived_from 依赖（纠错时要连带撤回）。 */
    dependentsOf(memoryId) {
        return this.db.all('SELECT from_id AS id, relation FROM memory_edges WHERE to_id = ?', memoryId);
    }
    /** 某条记忆的出边，供 /fish why 解释来源。 */
    edgesFrom(memoryId) {
        return this.db.all('SELECT to_id, relation FROM memory_edges WHERE from_id = ?', memoryId).map((row) => ({ toId: row.to_id, relation: row.relation }));
    }
    // ---------- tasks ----------
    insertTask(input) {
        this.db.run(`INSERT INTO tasks (id, principal_id, conversation_id, source_message_id, kind, content, status, due_at_ms, timezone, expires_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.id, input.principalId, input.conversationId, input.sourceMessageId, input.kind, input.content, input.status, input.dueAtMs, input.timezone, input.expiresAtMs, input.createdAtMs);
    }
    setTaskStatus(id, status) {
        this.db.run('UPDATE tasks SET status = ? WHERE id = ?', status, id);
    }
    dueTasks(nowMs, limit = 20) {
        return this.db.all(`SELECT * FROM tasks WHERE status = 'confirmed' AND due_at_ms IS NOT NULL AND due_at_ms <= ?
       ORDER BY due_at_ms LIMIT ?`, nowMs, limit);
    }
    pendingTasks(conversationId, limit = 10) {
        return this.db.all(`SELECT * FROM tasks WHERE conversation_id = ? AND status IN ('proposed','confirmed') ORDER BY COALESCE(due_at_ms, created_at_ms) LIMIT ?`, conversationId, limit);
    }
    // ---------- outbox ----------
    enqueueOutbox(input) {
        const existing = this.db.get('SELECT id FROM outbox WHERE candidate_key = ?', input.candidateKey);
        if (existing !== undefined)
            return { id: existing.id, inserted: false };
        this.db.run(`INSERT INTO outbox (id, conversation_id, turn_id, candidate_key, task_id, content, content_hash, status, expected_inbound_seq, planned_at_ms, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)`, input.id, input.conversationId, input.turnId, input.candidateKey, input.taskId, input.content, input.contentHash, input.expectedInboundSeq, input.plannedAtMs);
        return { id: input.id, inserted: true };
    }
    claimOutbox(nowMs, limit = 5) {
        return this.db.transaction(() => {
            const rows = this.db.all(`SELECT * FROM outbox WHERE status = 'pending' AND turn_id IS NULL AND planned_at_ms <= ? ORDER BY planned_at_ms LIMIT ?`, nowMs, limit);
            for (const row of rows) {
                this.db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?", row['id']);
            }
            return rows;
        });
    }
    finishOutbox(id, receipt) {
        const status = receipt.kind === 'accepted' ? 'sent' : receipt.kind === 'rejected' ? 'failed' : 'unknown';
        this.db.run('UPDATE outbox SET status = ?, sent_at_ms = ?, platform_message_id = ?, last_error_code = ? WHERE id = ?', status, receipt.atMs, receipt.platformMessageId ?? null, receipt.code ?? null, id);
    }
    claimReply(id) {
        return this.db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'", id).changes === 1;
    }
    cancelOutbox(id, reason) {
        this.db.run("UPDATE outbox SET status = 'cancelled', last_error_code = ? WHERE id = ? AND status IN ('pending','sending')", reason, id);
    }
    /**
     * 明确可重试的失败回到 pending（§14.4 有界重试）。
     * 只允许由 failed 转回 pending：unknown 永远不重发，sent 不许回退。
     */
    replanOutbox(id, plannedAtMs) {
        const result = this.db.run("UPDATE outbox SET status = 'pending', planned_at_ms = ?, sent_at_ms = NULL WHERE id = ? AND status = 'failed'", plannedAtMs, id);
        return result.changes > 0;
    }
    /** 进程重启：sending 一律降级为 unknown，绝不自动重发。 */
    recoverOutbox() {
        const result = this.db.run("UPDATE outbox SET status = 'unknown', last_error_code = COALESCE(last_error_code, 'restart_while_sending') WHERE status = 'sending'");
        return result.changes;
    }
    outboxStatus(id) {
        return this.db.get('SELECT status FROM outbox WHERE id = ?', id)?.status;
    }
    /** 主动消息闸门：该会话最近一条 outbox 记录（状态与时间都要看）。 */
    lastOutboxForConversation(conversationId) {
        return this.db.get('SELECT * FROM outbox WHERE conversation_id = ? ORDER BY planned_at_ms DESC LIMIT 1', conversationId);
    }
    /** 日限额与冷却：某会话在 [sinceMs, now] 内已发/在途的主动消息数。 */
    countOutboxSince(conversationId, sinceMs) {
        const row = this.db.get(`SELECT COUNT(*) AS n FROM outbox WHERE conversation_id = ? AND ${SPONTANEOUS_OUTBOX} AND planned_at_ms >= ? AND status IN ('pending','sending','sent','unknown')`, conversationId, sinceMs);
        return row?.n ?? 0;
    }
    /** 有过期未确认的主动消息（用于「未回复就暂停」判定，§14.2）。 */
    unresolvedOutbox(conversationId, sinceMs, unknownSinceMs = Date.now() - 24 * 3600_000) {
        return this.db.all(`SELECT * FROM outbox WHERE conversation_id IN (SELECT peer.id FROM conversations peer WHERE peer.principal_id = (SELECT principal_id FROM conversations WHERE id = ?)) AND ${SPONTANEOUS_OUTBOX}
       AND (CASE WHEN status='unknown' THEN COALESCE(sent_at_ms,planned_at_ms) ELSE planned_at_ms END) >= ?
       AND status IN ('pending','sending','sent','unknown')
       AND (status <> 'unknown' OR COALESCE(sent_at_ms,planned_at_ms) >= ?)
       AND NOT EXISTS (SELECT 1 FROM raw_messages r JOIN conversations c ON c.id = r.conversation_id WHERE c.principal_id = (SELECT principal_id FROM conversations WHERE id = outbox.conversation_id) AND ${humanSourceSql('r')} AND r.observed_at_ms > COALESCE(outbox.sent_at_ms, outbox.planned_at_ms))
       ORDER BY planned_at_ms`, conversationId, sinceMs, unknownSinceMs);
    }
    // ---------- topic checkpoints ----------
    currentCheckpoint(conversationId) {
        return this.db.get('SELECT * FROM topic_checkpoints WHERE conversation_id = ? AND current_flag = 1', conversationId);
    }
    putCheckpoint(input) {
        this.db.transaction(() => {
            this.db.run('UPDATE topic_checkpoints SET current_flag = 0 WHERE conversation_id = ? AND current_flag = 1', input.conversationId);
            this.db.run(`INSERT INTO topic_checkpoints (id, conversation_id, session_id, current_flag, summary_json, evidence_ids_json, created_at_ms)
         VALUES (?, ?, ?, 1, ?, ?, ?)`, input.id, input.conversationId, input.sessionId, json(input.summary), json(input.evidenceIds), input.createdAtMs);
        });
    }
    // ---------- background jobs ----------
    enqueueJob(input) {
        const result = this.db.run(`INSERT INTO background_jobs (id, dedup_key, principal_id, kind, payload_json, status, available_at_ms, attempts, created_at_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?)
       ON CONFLICT(dedup_key) DO NOTHING`, input.id, input.dedupKey, input.principalId, input.kind, json(input.payload), input.availableAtMs, input.createdAtMs);
        return result.changes > 0;
    }
    /**
     * 领任务。租约已过期的行视为孤儿（进程崩在 handler 里，没人来 finishJob），
     * 重新参与认领——否则崩溃留下的 'leased' 行永远不再执行，而整理调度会把
     * 它当成「已在排队」，让该会话的整理任务永久停摆。
     * 只回收已过期的行，绝不抢另一个活进程正在跑的任务。
     */
    claimJobs(nowMs, leaseMs, limit) {
        return this.db.transaction(() => {
            const rows = this.db.all(`SELECT * FROM background_jobs
         WHERE available_at_ms <= ?
           AND (status = 'pending' OR (status = 'leased' AND (lease_until_ms IS NULL OR lease_until_ms <= ?)))
         ORDER BY available_at_ms LIMIT ?`, nowMs, nowMs, limit);
            for (const row of rows) {
                this.db.run("UPDATE background_jobs SET status = 'leased', lease_until_ms = ?, attempts = attempts + 1 WHERE id = ?", nowMs + leaseMs, row['id']);
                // 返回自增后的 attempts：它就是这次租约的令牌，后续续租/回写都要带上它。
                row['attempts'] = Number(row['attempts'] ?? 0) + 1;
            }
            return rows;
        });
    }
    /**
     * 续租。只有「这一行仍是 leased 且 attempts 还是我这次领到的值」才算成功；
     * 租约被别的 worker 重领后 attempts 已变，这里返回 false，调用方必须停手。
     */
    renewJobLease(id, attempts, nowMs, leaseMs) {
        return this.db.run("UPDATE background_jobs SET lease_until_ms = ? WHERE id = ? AND status = 'leased' AND attempts = ?", nowMs + leaseMs, id, attempts).changes === 1;
    }
    /**
     * 失败重排。同样带 id + status='leased' + attempts 条件，旧 worker 不能把
     * 新 worker 正在跑的行改回 pending。
     */
    retryJob(id, attempts, availableAtMs, error) {
        return this.db.run("UPDATE background_jobs SET status = 'pending', lease_until_ms = NULL, available_at_ms = ?, last_error = ? WHERE id = ? AND status = 'leased' AND attempts = ?", availableAtMs, error, id, attempts).changes === 1;
    }
    /**
     * 收尾。传 attempts 时按租约条件更新，返回是否真的由本次执行写成；
     * 不传 attempts 时保留旧的「无条件写」语义（供外部/测试直接改状态）。
     */
    finishJob(id, status, error, attempts) {
        if (attempts === undefined) {
            return this.db.run('UPDATE background_jobs SET status = ?, last_error = ?, lease_until_ms = NULL WHERE id = ?', status, error ?? null, id).changes === 1;
        }
        return this.db.run("UPDATE background_jobs SET status = ?, last_error = ?, lease_until_ms = NULL WHERE id = ? AND status = 'leased' AND attempts = ?", status, error ?? null, id, attempts).changes === 1;
    }
    jobStats() {
        const rows = this.db.all('SELECT status, COUNT(*) AS n FROM background_jobs GROUP BY status');
        const out = {};
        for (const row of rows)
            out[row.status] = Number(row.n);
        return out;
    }
    // ---------- tombstones / audit ----------
    insertTombstone(input) {
        this.db.run('INSERT INTO deletion_tombstones (id, principal_id, selector_json, affected_ids_json, created_at_ms) VALUES (?, ?, ?, ?, ?)', input.id, input.principalId, json(input.selector), json(input.affectedIds), input.createdAtMs);
    }
    listTombstones(principalId) {
        return principalId === undefined
            ? this.db.all('SELECT * FROM deletion_tombstones ORDER BY created_at_ms')
            : this.db.all('SELECT * FROM deletion_tombstones WHERE principal_id = ? ORDER BY created_at_ms', principalId);
    }
    audit(input) {
        this.db.run('INSERT INTO audit_events (principal_id, kind, entity_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)', input.principalId, input.kind, input.entityId, json(input.payload), input.createdAtMs);
    }
    recentAudit(limit = 20) {
        return this.db.all('SELECT * FROM audit_events ORDER BY seq DESC LIMIT ?', limit);
    }
    counts() {
        const tables = [
            'raw_messages',
            'turns',
            'appraisals',
            'affect_events',
            'relationship_episodes',
            'memories',
            'tasks',
            'outbox',
            'background_jobs',
        ];
        const out = {};
        for (const table of tables) {
            const row = this.db.get(`SELECT COUNT(*) AS n FROM ${table}`);
            out[table] = Number(row?.n ?? 0);
        }
        return out;
    }
    /** 维护用：整库体积（页数 × 页大小），用于 doctor 与备份。 */
    databaseBytes() {
        // PRAGMA page_count 返回的列名就是 page_count，不是通用的 v；用表值函数形式取名字。
        const pageCount = Number(this.db.get('SELECT page_count FROM pragma_page_count()')?.page_count ?? 0);
        const pageSize = Number(this.db.get('SELECT page_size FROM pragma_page_size()')?.page_size ?? 0);
        return pageCount * pageSize;
    }
}
function toRawMessage(row) {
    return {
        seq: Number(row.seq),
        id: String(row.id),
        conversationId: String(row.conversation_id),
        platformMessageKey: row.platform_message_key ?? null,
        role: row.role,
        sourceKind: String(row.source_kind),
        content: String(row.content),
        occurredAtMs: Number(row.occurred_at_ms),
        observedAtMs: Number(row.observed_at_ms),
        deliveryStatus: row.delivery_status ?? null,
        deletedAtMs: row.deleted_at_ms === null || row.deleted_at_ms === undefined ? null : Number(row.deleted_at_ms),
    };
}
function toEpisode(row) {
    return {
        id: String(row['id']),
        principalId: String(row['principal_id']),
        conversationId: String(row['conversation_id']),
        kind: row['kind'],
        status: row['status'],
        sourceMessageIds: parse(row['source_message_ids_json'], []),
        appliedDeltas: parse(row['applied_deltas_json'], {
            affection: 0,
            trust: 0,
            respect: 0,
            grievance: 0,
        }),
        startedAtMs: Number(row['started_at_ms']),
        lastEventAtMs: Number(row['last_event_at_ms']),
        summary: String(row['summary']),
    };
}
export function toRememberedItem(row) {
    return {
        id: row.id,
        kind: row.kind,
        claim: row.claim,
        subjectKey: row.subject_key,
        predicateKey: row.predicate_key,
        visibility: row.visibility,
        confidence: row.confidence,
        salience: row.salience,
        validFromMs: row.valid_from_ms,
        validToMs: row.valid_to_ms,
        eventAtMs: row.event_at_ms,
        observedAtMs: row.observed_at_ms,
        evidenceIds: [],
    };
}
export { tokensToMatchQuery };
//# sourceMappingURL=repositories.js.map