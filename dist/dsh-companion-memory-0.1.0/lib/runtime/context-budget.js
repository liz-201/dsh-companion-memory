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
export const BUDGET = {
    persona: 1000,
    boundaries: 100,
    affectState: 150,
    recentDialogue: 1800,
    memoryAndCheckpoint: 350,
    protocolWrapper: 200,
    slack: 400,
    hardInputLimit: 4000,
};
export const BUDGET_SLICES = [
    'persona',
    'boundaries',
    'affectState',
    'recentDialogue',
    'memoryAndCheckpoint',
    'protocolWrapper',
];
/** 字符级保守估算：CJK 逐字，其余 4 字符 1 token；结果永不为负。 */
export function estimateTokens(text) {
    if (text === '')
        return 0;
    let cjk = 0;
    let other = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if ((code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0x3040 && code <= 0x30ff) ||
            (code >= 0xac00 && code <= 0xd7af)) {
            cjk += 1;
        }
        else {
            other += 1;
        }
    }
    return cjk + Math.ceil(other / 4);
}
export const estimatedCounter = {
    id: 'estimate-cjk-v1',
    estimated: true,
    count: estimateTokens,
};
/**
 * 组装 + 计量 + 降级。
 *
 * 降级顺序固定（§12.2）：
 *   删除重复或无关检索项 → 减少较旧的最近对话 → 更新当前话题检查点
 *   → 调用已验证的宿主压缩 → 重新计量
 * 全部用尽仍超限：给出 overBy 并标记 given-up，由调用方决定显式大输入处理。
 */
export function measureAndFit(input) {
    const counter = input.counter ?? estimatedCounter;
    const degradations = [];
    let persona = input.segments.persona;
    let memory = input.segments.memory;
    let checkpoint = input.segments.checkpoint;
    const dialogue = [...input.segments.recentDialogue];
    let droppedMemoryTokens = 0;
    const droppedDialogueIds = [];
    let checkpointUpdated = false;
    const build = () => {
        const dialogueText = dialogue.map((item) => `${labelFor(item.role)}${item.text}`).join('\n');
        const slices = [
            { slice: 'persona', tokens: counter.count(persona), budget: BUDGET.persona },
            { slice: 'boundaries', tokens: counter.count(input.segments.boundaries), budget: BUDGET.boundaries },
            { slice: 'affectState', tokens: counter.count(input.segments.affectState), budget: BUDGET.affectState },
            { slice: 'recentDialogue', tokens: counter.count(dialogueText), budget: BUDGET.recentDialogue },
            { slice: 'memoryAndCheckpoint', tokens: counter.count(memory) + counter.count(checkpoint), budget: BUDGET.memoryAndCheckpoint },
            { slice: 'protocolWrapper', tokens: counter.count(input.segments.protocolWrapper), budget: BUDGET.protocolWrapper },
        ];
        const total = slices.reduce((sum, item) => sum + item.tokens, 0);
        const fullText = [
            persona,
            input.segments.boundaries,
            input.segments.affectState,
            dialogueText,
            memory,
            checkpoint,
            input.segments.protocolWrapper,
        ]
            .filter((part) => part !== '')
            .join('\n\n');
        return { usage: slices, total, fullText, dialogueText };
    };
    let state = build();
    // ① 删除检索项（保留 checkpoint：它是主题连续性，比单条记忆更重要）。
    if (state.total > BUDGET.hardInputLimit && memory !== '') {
        const before = counter.count(memory);
        memory = '';
        droppedMemoryTokens = before;
        const after = build();
        degradations.push({ stage: 'dropped-retrieval', freedTokens: state.total - after.total });
        state = after;
    }
    // ② 从最旧的一端裁剪最近对话，但保留最后一条（当前用户消息）。
    while (state.total > BUDGET.hardInputLimit && dialogue.length > 2) {
        const before = state.total;
        const removed = dialogue.shift();
        if (removed !== undefined)
            droppedDialogueIds.push(removed.id);
        state = build();
        degradations.push({
            stage: 'trimmed-dialogue',
            freedTokens: before - state.total,
            detail: removed === undefined ? undefined : `drop:${removed.id}`,
        });
    }
    // ③ 更新检查点：压缩成一句话（保留主题与未完成约定，丢细节）。
    if (state.total > BUDGET.hardInputLimit && checkpoint !== '') {
        const before = state.total;
        checkpoint = compactCheckpoint(checkpoint);
        checkpointUpdated = true;
        state = build();
        degradations.push({ stage: 'updated-checkpoint', freedTokens: before - state.total });
    }
    // ④ 调用宿主压缩（只在确实还有压缩能力时）。
    if (state.total > BUDGET.hardInputLimit && input.hostCompact !== undefined) {
        const before = state.total;
        let compacted = null;
        try {
            compacted = input.hostCompact();
        }
        catch {
            compacted = null;
        }
        if (compacted !== null) {
            if (typeof compacted.persona === 'string' && compacted.persona !== '')
                persona = compacted.persona;
            if (typeof compacted.recentDialogueText === 'string') {
                dialogue.length = 0;
                dialogue.push({ id: 'host-compacted', text: compacted.recentDialogueText, role: 'internal' });
            }
            state = build();
            degradations.push({ stage: 'host-compaction', freedTokens: before - state.total });
        }
        else {
            degradations.push({ stage: 'host-compaction', freedTokens: 0, detail: '宿主压缩不可用' });
        }
    }
    const overBy = Math.max(0, state.total - BUDGET.hardInputLimit);
    if (overBy > 0) {
        degradations.push({ stage: 'given-up', freedTokens: 0, detail: `仍超出 ${overBy} token` });
    }
    return {
        report: {
            total: state.total,
            hardLimit: BUDGET.hardInputLimit,
            ok: overBy === 0,
            slices: state.usage,
            overBy,
            degradations,
            tokenizerId: counter.id,
            estimated: counter.estimated,
        },
        final: {
            persona,
            boundaries: input.segments.boundaries,
            affectState: input.segments.affectState,
            dialogue: state.dialogueText,
            memory,
            checkpoint,
            protocolWrapper: input.segments.protocolWrapper,
            fullText: state.fullText,
        },
        droppedMemoryTokens,
        droppedDialogueIds,
        checkpointUpdated,
    };
}
function labelFor(role) {
    if (role === 'user')
        return '用户：';
    if (role === 'assistant')
        return '我：';
    return '';
}
/**
 * 检查点压缩：只保留「当前主题 / 未完成约定 / 下一步」三类行。
 * 这是确定性的文本处理，不调用模型——预算降级不能引入新的网络等待。
 */
export function compactCheckpoint(checkpoint) {
    const lines = checkpoint.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    const keep = lines.filter((line) => /^(当前主题|未完成|下一步|待办|约定)/.test(line));
    const chosen = keep.length > 0 ? keep : lines.slice(0, 2);
    return chosen.map((line) => (line.length > 60 ? `${line.slice(0, 60)}…` : line)).join('\n');
}
export class TokenLedger {
    entries = [];
    record(entry) {
        this.entries.push(entry);
        // 保留最近 2000 条，避免长跑内存无界。
        if (this.entries.length > 2000)
            this.entries.splice(0, this.entries.length - 2000);
    }
    all() {
        return this.entries;
    }
    summary() {
        const empty = () => ({
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            reasoningTokens: 0,
        });
        const totals = { foreground: empty(), background: empty(), proactive: empty() };
        let unknownCount = 0;
        for (const entry of this.entries) {
            const bucket = totals[entry.phase];
            bucket.calls += 1;
            for (const key of ['inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens']) {
                const value = entry[key];
                if (value === 'unknown')
                    unknownCount += 1;
                else
                    bucket[key] += value;
            }
        }
        return { ...totals, unknownCount };
    }
}
//# sourceMappingURL=context-budget.js.map