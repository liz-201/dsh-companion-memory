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
import type { MemoryConfig } from '../config.js';
import type { MemoryKind, Visibility } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
export interface FactCandidate {
    /** 稳定 id（调用方生成，通常是 ulid/幂等键）。 */
    id: string;
    principalId: string;
    conversationId: string | null;
    visibility: Visibility;
    kind: MemoryKind;
    subject: string | null;
    predicate: string | null;
    object: unknown;
    claim: string;
    sourceKind: string;
    confidence: number;
    salience: number;
    /** 事件发生时间（用户说的时间）与入库观察时间（系统时间）。 */
    eventAtMs: number | null;
    observedAtMs: number;
    /** 声称的有效期；null 表示开放区间。 */
    validFromMs?: number | null;
    validToMs?: number | null;
    evidence: readonly {
        messageId: string;
        quote: string;
    }[];
    /** 可选显式关系：调用方已判断这是「更新」还是「与之冲突」。 */
    relation?: 'updates' | 'contradicts' | 'supports' | 'derived_from';
}
export type WriteOutcome = {
    type: 'inserted';
    id: string;
    supersededIds: string[];
} | {
    type: 'unchanged';
    id: string;
    reason: 'duplicate-evidence';
} | {
    type: 'conflict';
    id: string;
    conflictsWith: string[];
} | {
    type: 'rejected';
    reason: string;
};
export interface CorrectionOutcome {
    retracted: string[];
    cascaded: string[];
    notFound: boolean;
}
/** 规范化键：主题/谓语去空白与大小写，保证「住址」和「住址 」进同一桶。 */
export declare function keyOf(value: string | null): string | null;
export declare class FactUpdater {
    private readonly repos;
    /** 保留配置位，供后续按预算裁剪对象文本；当前只做 MAX_OBJECT_CHARS 截断。 */
    readonly config: MemoryConfig;
    constructor(repos: Repositories, 
    /** 保留配置位，供后续按预算裁剪对象文本；当前只做 MAX_OBJECT_CHARS 截断。 */
    config: MemoryConfig);
    /**
     * 写入一条候选。返回写入结果供调用方记账与 /fish why 展示。
     * 这是**幂等**操作：同一 id 重复写入不会产生第二行；同一证据重复引用不会累加证据。
     */
    write(candidate: FactCandidate): WriteOutcome;
    /**
     * 显式纠错（/fish correct、用户「你记错了」）。
     * 撤回目标 + 所有 derived_from 依赖，返回受影响 id，供审计与上下文剔除。
     */
    retract(memoryId: string, reason: string, nowMs: number): CorrectionOutcome;
    private retractMany;
    private insert;
    private findConflicts;
}
/** 证据去重：同一 messageId 只保留第一次引用（§10.2 重复原话不算多个独立证据）。 */
export declare function dedupeEvidence(evidence: readonly {
    messageId: string;
    quote: string;
}[]): {
    messageId: string;
    quote: string;
}[];
