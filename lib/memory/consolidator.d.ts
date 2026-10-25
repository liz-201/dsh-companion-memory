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
import type { BackgroundConfig } from '../config.js';
import type { MemoryKind } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
import type { RawMessage } from '../domain/types.js';
import { FactUpdater } from './fact-updater.js';
export interface BatchMessage {
    id: string;
    role: RawMessage['role'];
    content: string;
    occurredAtMs: number;
    seq: number;
}
export interface ConsolidationBatch {
    fragment?: {
        messageId: string;
        end: number;
        complete: boolean;
    };
    conversationId: string;
    principalId: string;
    messages: BatchMessage[];
    /** 本批覆盖到的 raw_messages.seq；下一批从 cursor+1 开始。 */
    cursor: number;
    estimatedTokens: number;
    dropped: number;
}
export interface ConsolidationChange {
    kind: MemoryKind;
    subject: string | null;
    predicate: string | null;
    object: unknown;
    claim: string;
    /** 必须来自本批消息的 id。 */
    sourceMessageIds: string[];
    quote: string;
    confidence: number;
    salience: number;
    eventAtMs: number | null;
    relation?: 'updates' | 'contradicts' | 'supports' | 'derived_from';
}
export interface ConsolidationPlan {
    changes: ConsolidationChange[];
    /** 模型认为未处理到的位置；缺省视作整批处理完。 */
    cursor?: number | null;
    /** 合并/摘要后的稳定偏好陈述（仍要带来源）。 */
    summary?: string | null;
}
export type ApplyReport = {
    applied: number;
    rejected: {
        index: number;
        reason: string;
    }[];
    nextCursor: number;
    touchedIds: string[];
};
/**
 * 选料：去重、丢噪声、按重要度与时间排序后装进预算。
 *
 * 重要度不是关键词打分器，而是「这条消息里有没有可提炼的内容」的粗判：
 * 明确陈述（我喜欢/我不喜欢/以后/记住/我叫）、边界（别/不要/不许）、约定（明天/几点）
 * 权重高；纯附和（嗯/好/哈哈）权重低。
 */
export declare class Consolidator {
    private readonly repos;
    private readonly config;
    private readonly updater;
    constructor(repos: Repositories, config: BackgroundConfig, updater: FactUpdater);
    planBatch(input: {
        conversationId: string;
        principalId: string;
        afterSeq: number;
        limit?: number;
    }): ConsolidationBatch;
    /**
     * 应用模型产出的结构化变更。
     * 任何一条不合规只拒绝**那一条**，不整批回滚——但会记录原因，供 /fish doctor 与审计。
     */
    applyPlan(batch: ConsolidationBatch, plan: ConsolidationPlan, nowMs: number): ApplyReport;
}
/** 校验单条变更；返回 null 表示通过。 */
export declare function validateChange(change: ConsolidationChange, known: ReadonlyMap<string, BatchMessage>): string | null;
export declare function memoryIdFor(principalId: string, change: ConsolidationChange): string;
/** 稳定的短哈希（FNV-1a 64 位转 base36），不依赖 crypto 的随机性。 */
export declare function hashKey(input: string): string;
