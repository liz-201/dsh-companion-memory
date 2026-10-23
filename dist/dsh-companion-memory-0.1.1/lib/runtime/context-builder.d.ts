/**
 * 提示词加载与动态上下文组装（任务书 §11、§12）。
 *
 * 两件事分开：
 *   · PromptStore —— 只能从磁盘上的 prompts/*.txt 读，**不内联**大段提示词。
 *     提示词是产品文件，要能被人改、被 diff、被测试断言，不能藏进代码字符串。
 *   · ContextBuilder —— 按 §12.1 的预算拼装并测量，产出 ContextSnapshot
 *     与会话历史（§7.4 只留正文）。
 *
 * 组装阶段**不做模型调用**：检索读的是已经准备好的快照，p95 预算 50ms（§17.1）。
 */
import type { MemoryConfig } from '../config.js';
import type { AffectSnapshot, RememberedItem } from '../domain/types.js';
import { type StateSummary } from '../domain/affect-reducer.js';
import type { ScoredMemory } from '../memory/retriever.js';
import { estimateTokens, type ContextSegments, type MeasureResult, type TokenCounter } from './context-budget.js';
export type PersonaPreset = 'irritable' | 'balanced' | 'gentle';
export interface PromptBundle {
    persona: string;
    protocol: string;
    consolidate: string;
}
export interface PromptStatus {
    directory: string;
    personaFiles: string[];
    protocol: boolean;
    consolidate: boolean;
    /** 缺失或为空的文件；非空即视为 degraded。 */
    problems: string[];
    /** 每个文件的字节数，便于确认不是空壳。 */
    sizes: Record<string, number>;
}
export declare class PromptStore {
    private readonly directory;
    private readonly cache;
    constructor(directory?: string);
    get path(): string;
    read(file: string): string;
    persona(preset: PersonaPreset): string;
    protocol(): string;
    consolidate(): string;
    load(preset: PersonaPreset): PromptBundle;
    /** doctor 与 /fish status 用；不抛异常，把问题列出来。 */
    status(): PromptStatus;
}
/** §11.3 动态状态模板：只写等级与方向，不写原始数值，≤150 token。 */
export declare function renderStateBlock(snapshot: AffectSnapshot, previous?: StateSummary): string;
/** §12.1 边界段：只放当前生效的约定与红线，控制在 100 token 内。 */
export declare function renderBoundaries(input: {
    agreements: readonly string[];
    pendingReminders: readonly string[];
    scopeNote: string;
}): string;
/**
 * 记忆段落：每条都带来源与时间，方便模型说「你上次说过」而不是凭空断言。
 * 预算不够时优先保留高分的少数几条（检索层已排序）。
 */
export declare function renderMemoryBlock(items: readonly (ScoredMemory | RememberedItem)[], maxItems?: number): string;
/** §12.3 话题检查点：当前主题 / 未完成约定 / 下一步。 */
export declare function renderCheckpoint(summary: {
    topic?: string;
    openItems?: readonly string[];
    nextStep?: string;
} | null): string;
export interface BuildContextInput {
    userText?: string;
    strategy?: string;
    persona: string;
    protocol: string;
    boundaries: string;
    snapshot: AffectSnapshot;
    previousSummary?: StateSummary | undefined;
    recent: readonly {
        id: string;
        text: string;
        role: string;
    }[];
    memoryItems: readonly ScoredMemory[];
    checkpoint: string;
    counter?: TokenCounter;
    hostCompact?: (() => {
        persona?: string;
        recentDialogueText?: string;
    } | null) | undefined;
    memoryConfig?: MemoryConfig;
}
export interface BuiltContext {
    segments: ContextSegments;
    measure: MeasureResult;
    stateText: string;
    memoryText: string;
    /** 本次实际注入的记忆 id（审计与 /fish why 用）。 */
    injectedMemoryIds: string[];
    estimatedTokens: number;
    estimated: boolean;
    tokenizerId: string;
}
/** 组装 + 测量；预算超限时按 §12.2 顺序降级。 */
export declare function buildContext(input: BuildContextInput): BuiltContext;
/** 预算报告的一行摘要，供 /fish status 与日志使用。 */
export declare function describeBudget(built: BuiltContext): string;
export { estimateTokens };
