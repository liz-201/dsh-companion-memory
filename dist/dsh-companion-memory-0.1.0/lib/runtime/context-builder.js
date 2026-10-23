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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeState } from '../domain/affect-reducer.js';
import { estimateTokens, measureAndFit } from './context-budget.js';
const PERSONA_FILES = {
    irritable: 'persona-irritable.txt',
    balanced: 'persona-balanced.txt',
    gentle: 'persona-gentle.txt',
};
function defaultPromptDirectory() {
    // lib/runtime/context-builder.js → ../../prompts
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', 'prompts');
}
export class PromptStore {
    directory;
    cache = null;
    constructor(directory) {
        this.directory = directory ?? defaultPromptDirectory();
    }
    get path() {
        return this.directory;
    }
    read(file) {
        const full = join(this.directory, file);
        if (!existsSync(full))
            throw new Error(`缺少提示词文件：${full}`);
        const text = readFileSync(full, 'utf8');
        if (text.trim() === '')
            throw new Error(`提示词文件为空：${full}`);
        return text;
    }
    persona(preset) {
        return this.read(PERSONA_FILES[preset]);
    }
    protocol() {
        return this.read('protocol.txt');
    }
    consolidate() {
        return this.read('consolidate.txt');
    }
    load(preset) {
        if (this.cache !== null)
            return this.cache;
        const bundle = {
            persona: this.persona(preset),
            protocol: this.protocol(),
            consolidate: this.consolidate(),
        };
        this.cache = bundle;
        return bundle;
    }
    /** doctor 与 /fish status 用；不抛异常，把问题列出来。 */
    status() {
        const sizes = {};
        const problems = [];
        const personaFiles = [];
        for (const file of Object.values(PERSONA_FILES)) {
            const full = join(this.directory, file);
            if (!existsSync(full)) {
                problems.push(`缺少 ${file}`);
                continue;
            }
            const text = readFileSync(full, 'utf8');
            sizes[file] = Buffer.byteLength(text, 'utf8');
            if (text.trim() === '')
                problems.push(`${file} 为空`);
            else
                personaFiles.push(file);
        }
        let protocolOk = false;
        let consolidateOk = false;
        for (const [flag, file] of [
            ['protocol.txt', 'protocol.txt'],
            ['consolidate.txt', 'consolidate.txt'],
        ]) {
            const full = join(this.directory, file);
            if (!existsSync(full)) {
                problems.push(`缺少 ${file}`);
                continue;
            }
            const text = readFileSync(full, 'utf8');
            sizes[file] = Buffer.byteLength(text, 'utf8');
            if (text.trim() === '')
                problems.push(`${file} 为空`);
            else if (flag === 'protocol.txt')
                protocolOk = true;
            else
                consolidateOk = true;
        }
        return {
            directory: this.directory,
            personaFiles,
            protocol: protocolOk,
            consolidate: consolidateOk,
            problems,
            sizes,
        };
    }
}
/** §11.3 动态状态模板：只写等级与方向，不写原始数值，≤150 token。 */
export function renderStateBlock(snapshot, previous) {
    const summary = summarizeState(snapshot, previous);
    const lines = [
        `当前心情：${summary.moodLevels}`,
        `和对方：${summary.relationshipLevels}`,
        `未了结：${summary.episodeHint}`,
    ];
    if (summary.rules !== '')
        lines.push(summary.rules);
    return lines.join('\n');
}
/** §12.1 边界段：只放当前生效的约定与红线，控制在 100 token 内。 */
export function renderBoundaries(input) {
    const parts = [input.scopeNote];
    if (input.agreements.length > 0) {
        parts.push(`现有约定：${input.agreements.slice(0, 3).map(shorten).join('；')}`);
    }
    if (input.pendingReminders.length > 0) {
        parts.push(`待提醒：${input.pendingReminders.slice(0, 3).map(shorten).join('；')}`);
    }
    return parts.join('\n');
}
function shorten(text, max = 24) {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
/**
 * 记忆段落：每条都带来源与时间，方便模型说「你上次说过」而不是凭空断言。
 * 预算不够时优先保留高分的少数几条（检索层已排序）。
 */
export function renderMemoryBlock(items, maxItems = 6) {
    if (items.length === 0)
        return '';
    const chosen = items.slice(0, maxItems);
    const lines = chosen.map((entry) => {
        const item = 'item' in entry ? entry.item : entry;
        const when = item.eventAtMs !== null ? formatDate(item.eventAtMs) : formatDate(item.observedAtMs);
        const stale = item.validToMs !== null ? `（到 ${formatDate(item.validToMs)} 为止）` : '';
        return `· [${when}] ${item.claim}${stale}`;
    });
    return `你记得的事（有来源，别编造）：\n${lines.join('\n')}`;
}
function formatDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** §12.3 话题检查点：当前主题 / 未完成约定 / 下一步。 */
export function renderCheckpoint(summary) {
    if (summary === null)
        return '';
    const lines = [];
    if (summary.topic !== undefined && summary.topic !== '')
        lines.push(`当前主题：${summary.topic}`);
    if (summary.openItems !== undefined && summary.openItems.length > 0) {
        lines.push(`未完成：${summary.openItems.slice(0, 3).join('；')}`);
    }
    if (summary.nextStep !== undefined && summary.nextStep !== '')
        lines.push(`下一步：${summary.nextStep}`);
    return lines.join('\n');
}
/** 组装 + 测量；预算超限时按 §12.2 顺序降级。 */
export function buildContext(input) {
    const stateText = renderStateBlock(input.snapshot, input.previousSummary);
    const memoryText = renderMemoryBlock(input.memoryItems, input.memoryConfig?.selectedLimit ?? 6);
    const segments = {
        persona: input.persona,
        boundaries: input.boundaries,
        affectState: stateText,
        recentDialogue: input.recent,
        memory: memoryText,
        checkpoint: input.checkpoint,
        protocolWrapper: input.protocol,
    };
    const measure = measureAndFit({
        segments,
        counter: input.counter,
        hostCompact: input.hostCompact,
    });
    const injected = memoryText === '' ? [] : input.memoryItems.slice(0, input.memoryConfig?.selectedLimit ?? 6).map((item) => item.item.id);
    return {
        segments,
        measure,
        stateText,
        memoryText,
        injectedMemoryIds: measure.droppedMemoryTokens > 0 ? [] : injected,
        estimatedTokens: measure.report.total,
        estimated: measure.report.estimated,
        tokenizerId: measure.report.tokenizerId,
    };
}
/** 预算报告的一行摘要，供 /fish status 与日志使用。 */
export function describeBudget(built) {
    const report = built.measure.report;
    const slice = report.slices.map((item) => `${item.slice}=${item.tokens}/${item.budget}`).join(' ');
    const degraded = report.degradations.length === 0 ? '' : ` 降级=${report.degradations.map((d) => d.stage).join('>')}`;
    return `tokens=${report.total}/${report.hardLimit} (${built.tokenizerId}${built.estimated ? ' est' : ''}) ${slice}${degraded}`;
}
export { estimateTokens };
//# sourceMappingURL=context-builder.js.map