/**
 * 自建领域类型（任务书 §4）。
 *
 * 这里是**本插件自己的**接口，不是 DSH 原生 API。与宿主交互的边界在
 * adapters/ 下，宿主类型通过 unknown → 收窄完成，不用 any 敷衍。
 */
export type Visibility = 'private' | 'group' | 'shared';
export type EventKind = 'insult' | 'teasing' | 'apology' | 'appreciation' | 'correction' | 'boundary' | 'promise_kept' | 'promise_broken' | 'reassurance' | 'neutral';
export type Intent = 'hostile' | 'playful' | 'repair' | 'neutral' | 'uncertain';
export type Target = 'self' | 'problem' | 'third_party' | 'unknown';
export type ExpressAction = 'neutral' | 'support' | 'tease' | 'retort' | 'withdraw' | 'repair' | 'explain' | 'ask';
export type PresetId = 'irritable' | 'balanced' | 'gentle';
export interface IdentityBinding {
    companionId: string;
    botAccountId: string;
    userId: string;
    conversationId: string;
    conversationKind: 'private' | 'group';
    principalId: string;
    visibility: Visibility;
}
export interface Personality {
    irritability: number;
    sensitivity: number;
    directness: number;
    selfControl: number;
    warmth: number;
    initiative: number;
}
export interface Relationship {
    affection: number;
    trust: number;
    respect: number;
    familiarity: number;
    grievance: number;
}
export interface Mood {
    anger: number;
    hurt: number;
    joy: number;
    tension: number;
    expressiveness: number;
}
export interface AffectSnapshot {
    principalId: string;
    revision: number;
    projectedThroughSeq: number;
    asOfMs: number;
    personality: Personality;
    relationship: Relationship;
    mood: Mood;
    openEpisodeIds: string[];
    ruleVersion: string;
}
/** 经过服务端绑定与来源校验后的评价；模型不能指定 sourceMessageId。 */
export interface ValidatedAppraisal {
    sourceMessageId: string;
    kind: EventKind;
    intent: Intent;
    target: Target;
    severity: 0 | 1 | 2 | 3;
    confidence: number;
    evidenceQuote?: string;
    source: 'live_tail' | 'background' | 'owner_correction';
    revision: number;
}
export interface ContextSnapshot {
    stateRevision: number;
    text: string;
    evidenceIds: string[];
    estimatedTokens: number;
    tokenizerId: string;
}
export interface DeliveryReceipt {
    kind: 'accepted' | 'rejected' | 'unknown';
    platformMessageId?: string;
    code?: string;
    atMs: number;
}
export interface QueuedTurnTask {
    readonly conversationId: string;
    readonly turnId: string;
    run(): Promise<void>;
}
export type MemoryKind = 'episode' | 'fact' | 'preference' | 'interaction_rule' | 'hypothesis';
export type TaskKind = 'reminder' | 'open_topic' | 'commitment' | 'repair';
export type TaskStatus = 'proposed' | 'confirmed' | 'done' | 'cancelled' | 'expired';
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled';
export interface RawMessage {
    seq: number;
    id: string;
    conversationId: string;
    platformMessageKey: string | null;
    role: 'user' | 'assistant' | 'internal' | 'tool';
    sourceKind: string;
    content: string;
    occurredAtMs: number;
    observedAtMs: number;
    deliveryStatus: string | null;
    deletedAtMs: number | null;
}
export interface RememberedItem {
    id: string;
    kind: MemoryKind;
    claim: string;
    subjectKey: string | null;
    predicateKey: string | null;
    visibility: Visibility;
    confidence: number;
    salience: number;
    validFromMs: number | null;
    validToMs: number | null;
    eventAtMs: number | null;
    observedAtMs: number;
    evidenceIds: string[];
    score?: number;
    scoreReasons?: string[];
}
export interface EpisodeRecord {
    id: string;
    principalId: string;
    conversationId: string;
    kind: EventKind;
    status: 'open' | 'repairing' | 'resolved' | 'archived';
    sourceMessageIds: string[];
    appliedDeltas: RelationshipDelta;
    startedAtMs: number;
    lastEventAtMs: number;
    summary: string;
}
export interface RelationshipDelta {
    affection: number;
    trust: number;
    respect: number;
    grievance: number;
}
export interface Clock {
    now(): number;
}
export declare const systemClock: Clock;
/** 固定基线时钟：回放与单测用它，禁止 reducer 隐式读 Date.now()。 */
export declare function fixedClock(startMs: number, stepMs?: number): Clock;
