/**
 * 长程记忆检索（任务书 §10.3）。
 *
 * 管线顺序是硬约束，测试按阶段断言：
 *   scope/visibility/删除/status 过滤
 *   → 查询词
 *   → 实体/别名/当前事实/全文/未结事项检索
 *   → 排名融合 + 去重 + 冲突检查
 *   → 证据展开
 *   → 预算打包（3–6 条；无相关则不注入）
 *
 * 这里不生成 FTS 语法细节（lexical-index 负责），也不做 token 计数（context-budget 负责）。
 * 所有结果都是**只读**的：检索不得改动 confidence、不得新增证据、不得写库。
 */
import type { MemoryConfig } from '../config.js';
import type { IdentityBinding, RememberedItem } from '../domain/types.js';
import type { MemoryRow, Repositories } from '../storage/repositories.js';
import { type AliasDictionary } from './lexical-index.js';
export interface RetrievalRequest {
    binding: IdentityBinding;
    /** 当轮用户原话（已脱敏，未截断）。 */
    query: string;
    /** 当前心情的绝对唤醒度 0..1；只做 ±10–15% 的微调。 */
    emotionArousal?: number;
    /** 事实型问题不叠加情绪加分。 */
    forceFactual?: boolean;
    nowMs: number;
    dictionary?: AliasDictionary;
}
export interface ScoredMemory {
    row: MemoryRow;
    item: RememberedItem;
    score: number;
    reasons: string[];
    channels: string[];
    /** 与另一条记忆冲突（同 subject/predicate 但值不同）。 */
    conflictsWith: string[];
}
export interface RetrievalResult {
    /** 通过过滤与打分的候选（上限 candidateLimit）。 */
    candidates: ScoredMemory[];
    /** 预算内选中的条目（3–6 条，可能为 0）。 */
    selected: ScoredMemory[];
    /** 明确被排除的条目及原因，供 /fish why 与测试使用。 */
    excluded: {
        id: string;
        reason: string;
    }[];
    terms: {
        tokens: string[];
        expanded: string[];
        factual: boolean;
    };
    ftsAvailable: boolean;
    elapsedMs: number;
}
export declare class Retriever {
    private readonly repos;
    private readonly config;
    constructor(repos: Repositories, config: MemoryConfig);
    retrieve(request: RetrievalRequest): RetrievalResult;
    /** 预算打包：少于 3 条时不硬凑；超过 selectedLimit 时按分数截断。 */
    private pack;
    private subjectHints;
    private isTimeConditioned;
}
/** 给每条记忆一个稳定的、可展示的条目（证据 id 列表补齐）。 */
export declare function toItem(row: MemoryRow, evidenceCount?: number): RememberedItem;
/**
 * 粗估 token：中文按 1 字≈1 token，拉丁按 4 字符≈1 token。
 * 与 context-budget 的估算器保持同一口径（见该文件的 estimateTokens）。
 */
export declare function estimateCost(item: RememberedItem): number;
