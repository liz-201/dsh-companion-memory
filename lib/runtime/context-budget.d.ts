/**
 * 上下文预算（任务书 §12.1、§12.2、§12.5）。
 *
 * 两条硬规矩：
 *   1. 在**模型调用前**测量最终序列，不是只算新增的 memory block。
 *   2. 超预算时按固定顺序降级，并记录每一级的实际做法；不能静默丢用户当前材料。
 *
 * tokenizer：优先用宿主提供的计数函数（上下文里注入），否则用保守估算并在报告里
 * 明确标注 estimated。汉字 1 字 ≈ 1 token、拉丁 4 字符 ≈ 1 token 是**下界估计**，
 * 不比 provider 更准，具体误差由 docs/ACCEPTANCE_REPORT.md 记录。
 */
export interface TokenCounter {
    id: string;
    /** provider 真实 tokenizer 可用时为 false。 */
    estimated: boolean;
    count(text: string): number;
}
export declare const BUDGET: {
    readonly persona: 1000;
    readonly boundaries: 100;
    readonly affectState: 150;
    readonly recentDialogue: 1800;
    readonly memoryAndCheckpoint: 350;
    readonly protocolWrapper: 200;
    readonly slack: 400;
    readonly hardInputLimit: 4000;
};
export type BudgetSlice = keyof Omit<typeof BUDGET, 'hardInputLimit' | 'slack'>;
export declare const BUDGET_SLICES: readonly BudgetSlice[];
/** 字符级保守估算：CJK 逐字，其余 4 字符 1 token；结果永不为负。 */
export declare function estimateTokens(text: string): number;
export declare const estimatedCounter: TokenCounter;
export interface SliceUsage {
    slice: BudgetSlice;
    tokens: number;
    budget: number;
}
export interface BudgetReport {
    total: number;
    hardLimit: number;
    ok: boolean;
    slices: SliceUsage[];
    overBy: number;
    /** 已执行的降级步骤，按发生顺序。 */
    degradations: DegradationStep[];
    tokenizerId: string;
    estimated: boolean;
}
export interface DegradationStep {
    stage: 'dropped-retrieval' | 'trimmed-dialogue' | 'updated-checkpoint' | 'host-compaction' | 'given-up';
    freedTokens: number;
    detail?: string;
}
/** 待测量的一段输入。 */
export interface ContextSegments {
    persona: string;
    boundaries: string;
    affectState: string;
    recentDialogue: readonly {
        id: string;
        text: string;
        role?: string;
    }[];
    memory: string;
    checkpoint: string;
    protocolWrapper: string;
}
export interface MeasureInput {
    segments: ContextSegments;
    counter?: TokenCounter;
    userText?: string;
    hardInputLimit?: number;
    /** 超限时可调用的宿主压缩实现；返回压缩后文本或 null 表示不可用。 */
    hostCompact?: (() => {
        persona?: string;
        recentDialogueText?: string;
    } | null) | undefined;
}
export interface MeasureResult {
    report: BudgetReport;
    /** 实际送进模型的各段文本（可能已被裁剪）。 */
    final: {
        persona: string;
        boundaries: string;
        affectState: string;
        dialogue: string;
        memory: string;
        checkpoint: string;
        protocolWrapper: string;
        /** 拼好的完整输入，供调用方再次自检。 */
        fullText: string;
    };
    /** 因预算被删掉的检索条目 id。 */
    droppedMemoryTokens: number;
    droppedDialogueIds: string[];
    checkpointUpdated: boolean;
}
/**
 * 组装 + 计量 + 降级。
 *
 * 降级顺序固定（§12.2）：
 *   删除重复或无关检索项 → 减少较旧的最近对话 → 更新当前话题检查点
 *   → 调用已验证的宿主压缩 → 重新计量
 * 全部用尽仍超限：给出 overBy 并标记 given-up，由调用方决定显式大输入处理。
 */
export declare function measureAndFit(input: MeasureInput): MeasureResult;
/**
 * 检查点压缩：只保留「当前主题 / 未完成约定 / 下一步」三类行。
 * 这是确定性的文本处理，不调用模型——预算降级不能引入新的网络等待。
 */
export declare function compactCheckpoint(checkpoint: string): string;
/** §12.5 token 账本的一行记录；字段允许 unknown，绝不把未知填 0。 */
export interface TokenLedgerEntry {
    turnId: string;
    phase: 'foreground' | 'background' | 'proactive' | 'evaluation' | 'perception';
    provider: string;
    model: string;
    inputTokens: number | 'unknown';
    outputTokens: number | 'unknown';
    cacheHitTokens: number | 'unknown';
    cacheMissTokens: number | 'unknown';
    reasoningTokens: number | 'unknown';
    /** 各类内容的估计占比（0..1），仅在被测量时填写。 */
    composition?: {
        fixedPrompt?: number;
        dynamicState?: number;
        retrieval?: number;
        visibleBody?: number;
        internalTags?: number;
    };
    retry: number;
    atMs: number;
    pricedAt?: string;
    estimatedCost?: number | 'unknown';
}
export declare class TokenLedger {
    private readonly entries;
    record(entry: TokenLedgerEntry): void;
    all(): readonly TokenLedgerEntry[];
    summary(): {
        foreground: TokenTotals;
        background: TokenTotals;
        proactive: TokenTotals;
        evaluation: TokenTotals;
        perception: TokenTotals;
        unknownCount: number;
    };
}
export interface TokenTotals {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    reasoningTokens: number;
}
