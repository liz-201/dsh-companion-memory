/**
 * 仓储层（任务书 §5.2 / §6.3）。
 *
 * 所有 SQL 集中在这里，其他模块只调用方法。几条硬约束：
 *   - 写操作一律带幂等键或唯一约束，重复调用不会重复扣分；
 *   - affect snapshot 用「期望 revision」做乐观并发，冲突直接抛错由队列重试；
 *   - FTS 是派生索引：记忆状态变化时同步维护，不允许只改 memories 不改 FTS。
 */
import type { Database, Row } from './database.js';
import type { AffectSnapshot, DeliveryReceipt, EpisodeRecord, MemoryKind, Personality, RawMessage, RememberedItem, TaskKind, TaskStatus, Visibility } from '../domain/types.js';
import { tokensToMatchQuery } from '../memory/normalizer.js';
export interface CompanionRow {
    id: string;
    name: string;
    personality_json: string;
    created_at_ms: number;
}
export interface PrincipalRow {
    id: string;
    companion_id: string;
    bot_account_id: string;
    user_id: string;
    created_at_ms: number;
}
export interface ConversationRow {
    id: string;
    principal_id: string;
    kind: 'private' | 'group';
    platform_conversation_id: string;
    active_session_id: string | null;
    latest_inbound_seq: number;
    enabled: number;
}
export interface TurnRow {
    id: string;
    conversation_id: string;
    session_id: string;
    inbound_message_id: string | null;
    state_revision_used: number | null;
    status: string;
    say_status: string;
    tail_status: string;
    started_at_ms: number;
    ended_at_ms: number | null;
}
export interface MemoryRow {
    id: string;
    principal_id: string;
    conversation_id: string | null;
    visibility: Visibility;
    kind: MemoryKind;
    subject_key: string | null;
    predicate_key: string | null;
    object_json: string | null;
    claim: string;
    source_kind: string;
    status: string;
    confidence: number;
    salience: number;
    valid_from_ms: number | null;
    valid_to_ms: number | null;
    event_at_ms: number | null;
    observed_at_ms: number;
    activation_at_ms: number;
    embedding_model_id: string | null;
    created_at_ms: number;
}
export interface InsertMemoryInput {
    id: string;
    principalId: string;
    conversationId: string | null;
    visibility: Visibility;
    kind: MemoryKind;
    subjectKey: string | null;
    predicateKey: string | null;
    object: unknown;
    claim: string;
    sourceKind: string;
    confidence: number;
    salience: number;
    validFromMs: number | null;
    validToMs: number | null;
    eventAtMs: number | null;
    observedAtMs: number;
    activationAtMs: number;
    evidence: readonly {
        messageId: string;
        quote: string;
    }[];
    lexicalTerms: string;
    aliases: string;
    edge?: {
        toId: string;
        relation: 'supports' | 'contradicts' | 'updates' | 'derived_from';
    } | undefined;
}
export declare class Repositories {
    readonly db: Database;
    constructor(db: Database);
    ensureCompanion(id: string, name: string, personality: Personality, nowMs: number): void;
    ensurePrincipal(id: string, companionId: string, botAccountId: string, userId: string, nowMs: number): PrincipalRow;
    ensureConversation(id: string, principalId: string, kind: 'private' | 'group', platformConversationId: string, nowMs: number): ConversationRow;
    setActiveSession(conversationId: string, sessionId: string): void;
    setConversationEnabled(conversationId: string, enabled: boolean): void;
    /**
     * 插入原始消息。同一 (conversation, platform key, role) 重复到达时返回既有行，
     * 上层据此判定「这条已经处理过」，不会启动第二个回复回合。
     */
    insertRawMessage(message: Omit<RawMessage, 'seq'>): {
        row: RawMessage;
        inserted: boolean;
    };
    getRawMessage(id: string): RawMessage | undefined;
    recentRawMessages(conversationId: string, limit: number, beforeSeq?: number): RawMessage[];
    /**
     * 巩固用增量：seq 大于 afterSeq 的真实消息，按时间正序。
     * 与 recentRawMessages 不同，这里**不反转**，且把删除行也带上——调用方需要
     * 用 deleted_at_ms 判断跳过后仍推进游标（否则游标会被删除行永久卡住）。
     */
    rawMessagesAfter(conversationId: string, afterSeq: number, limit: number): RawMessage[];
    latestInboundSeq(conversationId: string): number;
    softDeleteMessage(id: string, nowMs: number): void;
    createTurn(turn: Omit<TurnRow, 'say_status' | 'tail_status' | 'ended_at_ms'> & {
        sayStatus?: string;
        tailStatus?: string;
    }): void;
    updateTurn(turnId: string, patch: Partial<Pick<TurnRow, 'status' | 'say_status' | 'tail_status' | 'ended_at_ms' | 'state_revision_used'>>): void;
    getTurn(id: string): TurnRow | undefined;
    insertAppraisal(input: {
        id: string;
        sourceMessageId: string;
        revision: number;
        kind: string;
        intent: string;
        target: string;
        severity: number;
        confidence: number;
        evidenceQuote: string | null;
        producer: string;
        status: 'active' | 'superseded' | 'retracted' | 'pending';
        createdAtMs: number;
    }): void;
    setAppraisalStatus(id: string, status: 'active' | 'superseded' | 'retracted' | 'pending'): void;
    listAppraisalsForSource(sourceMessageId: string): Row[];
    getSnapshot(principalId: string): {
        snapshot: AffectSnapshot;
        revision: number;
        projectedThroughSeq: number;
    } | undefined;
    /** 乐观并发：数据库里的 revision 必须等于 expected，否则抛冲突。 */
    putSnapshot(snapshot: AffectSnapshot, expectedRevision: number): void;
    /**
     * 追加 affect event。idempotency_key 唯一：重复投递返回既有行且 inserted=false，
     * 保证「同一条消息重放两次」不会扣两次分。
     */
    appendAffectEvent(input: {
        id: string;
        principalId: string;
        conversationId: string;
        appraisalId: string | null;
        episodeId: string | null;
        idempotencyKey: string;
        eventTimeMs: number;
        payload: unknown;
        ruleVersion: string;
        status: 'active' | 'superseded' | 'retracted';
        createdAtMs: number;
    }): {
        seq: number;
        inserted: boolean;
    };
    countAffectEvents(principalId: string, sinceMs: number): number;
    activeAffectEvents(principalId: string): Row[];
    /** 最近一条影响关系的事件（`/fish why` 用）。 */
    lastAffectEvent(principalId: string): Row | undefined;
    getAffectEvent(seq: number): Row | undefined;
    /**
     * 撤回一条情感事件（§15.1 `correct`）。
     * 不直接改数值：标记 retracted 后由调用方重投影，历史保持可追溯。
     */
    retractAffectEvent(seq: number, reason: string): boolean;
    getSetting(key: string): string | undefined;
    setSetting(key: string, value: string, updatedAtMs: number): void;
    upsertEpisode(record: EpisodeRecord, isNew: boolean): void;
    listEpisodes(principalId: string, statuses: readonly string[], limit?: number): EpisodeRecord[];
    getEpisode(id: string): EpisodeRecord | undefined;
    insertMemory(input: InsertMemoryInput): void;
    /** FTS 写入失败不能让整条记忆写不进去：降级为 LIKE 检索并记录状态。 */
    indexMemory(memoryId: string, principalId: string, lexicalTerms: string, aliases: string): boolean;
    removeFromIndex(memoryId: string): void;
    setMemoryStatus(id: string, status: 'active' | 'superseded' | 'retracted' | 'archived', nowMs: number): void;
    getMemory(id: string): MemoryRow | undefined;
    memoryEvidence(memoryId: string): {
        messageId: string;
        quote: string;
    }[];
    /** FTS 检索；返回 id 与 bm25 分数（越小越相关）。FTS 不可用时返回 undefined。 */
    searchFts(principalId: string, matchQuery: string, limit: number): {
        id: string;
        rank: number;
    }[] | undefined;
    /** LIKE 退化路径：FTS5 不可用或查询语法出问题时使用。 */
    searchLike(principalId: string, tokens: readonly string[], limit: number): {
        id: string;
        rank: number;
    }[];
    activeMemories(principalId: string, kinds: readonly MemoryKind[], limit: number): MemoryRow[];
    allMemories(principalId: string, limit?: number): MemoryRow[];
    /** 同 subject+predicate 的活跃事实，用于「以前住成都，现在在重庆」。 */
    factsBySubject(principalId: string, subjectKey: string, predicateKey: string): MemoryRow[];
    updateMemoryFields(id: string, patch: Partial<Pick<MemoryRow, 'salience' | 'valid_to_ms' | 'activation_at_ms'>>): void;
    /** 追加一条证据；重复引用同一 message_id 不累加（§10.2）。 */
    addMemoryEvidence(memoryId: string, messageId: string, quote: string): void;
    /** 写入记忆间关系边。 */
    addEdge(fromId: string, toId: string, relation: 'supports' | 'contradicts' | 'updates' | 'derived_from'): void;
    /** 收口有效期：保留历史行，只标记「到此为止」。 */
    closeValidity(id: string, validToMs: number): void;
    /** derived_from 依赖（纠错时要连带撤回）。 */
    dependentsOf(memoryId: string): {
        id: string;
        relation: string;
    }[];
    /** 某条记忆的出边，供 /fish why 解释来源。 */
    edgesFrom(memoryId: string): {
        toId: string;
        relation: string;
    }[];
    insertTask(input: {
        id: string;
        principalId: string;
        conversationId: string;
        sourceMessageId: string | null;
        kind: TaskKind;
        content: string;
        status: TaskStatus;
        dueAtMs: number | null;
        timezone: string;
        expiresAtMs: number | null;
        createdAtMs: number;
    }): void;
    setTaskStatus(id: string, status: TaskStatus): void;
    dueTasks(nowMs: number, limit?: number): Row[];
    pendingTasks(conversationId: string, limit?: number): Row[];
    enqueueOutbox(input: {
        id: string;
        conversationId: string;
        turnId: string | null;
        candidateKey: string;
        taskId: string | null;
        content: string;
        contentHash: string;
        plannedAtMs: number;
        expectedInboundSeq: number | null;
    }): {
        id: string;
        inserted: boolean;
    };
    claimOutbox(nowMs: number, limit?: number): Row[];
    finishOutbox(id: string, receipt: DeliveryReceipt): void;
    claimReply(id: string): boolean;
    cancelOutbox(id: string, reason: string): void;
    /**
     * 明确可重试的失败回到 pending（§14.4 有界重试）。
     * 只允许由 failed 转回 pending：unknown 永远不重发，sent 不许回退。
     */
    replanOutbox(id: string, plannedAtMs: number): boolean;
    /** 进程重启：sending 一律降级为 unknown，绝不自动重发。 */
    recoverOutbox(): number;
    outboxStatus(id: string): string | undefined;
    /** 主动消息闸门：该会话最近一条 outbox 记录（状态与时间都要看）。 */
    lastOutboxForConversation(conversationId: string): Row | undefined;
    /** 日限额与冷却：某会话在 [sinceMs, now] 内已发/在途的主动消息数。 */
    countOutboxSince(conversationId: string, sinceMs: number): number;
    /** 有过期未确认的主动消息（用于「未回复就暂停」判定，§14.2）。 */
    unresolvedOutbox(conversationId: string, sinceMs: number): Row[];
    currentCheckpoint(conversationId: string): Row | undefined;
    putCheckpoint(input: {
        id: string;
        conversationId: string;
        sessionId: string;
        summary: unknown;
        evidenceIds: string[];
        createdAtMs: number;
    }): void;
    enqueueJob(input: {
        id: string;
        dedupKey: string;
        principalId: string | null;
        kind: string;
        payload: unknown;
        availableAtMs: number;
        createdAtMs: number;
    }): boolean;
    claimJobs(nowMs: number, leaseMs: number, limit: number): Row[];
    finishJob(id: string, status: 'done' | 'failed' | 'cancelled', error?: string): void;
    jobStats(): Record<string, number>;
    insertTombstone(input: {
        id: string;
        principalId: string;
        selector: unknown;
        affectedIds: string[];
        createdAtMs: number;
    }): void;
    listTombstones(principalId?: string): Row[];
    audit(input: {
        principalId: string | null;
        kind: string;
        entityId: string | null;
        payload: unknown;
        createdAtMs: number;
    }): void;
    recentAudit(limit?: number): Row[];
    counts(): Record<string, number>;
    /** 维护用：整库体积（页数 × 页大小），用于 doctor 与备份。 */
    databaseBytes(): number;
}
export declare function toRememberedItem(row: MemoryRow): RememberedItem;
export { tokensToMatchQuery };
