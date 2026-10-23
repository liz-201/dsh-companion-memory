/**
 * 输出协议：schema 单一真源 + 校验 + 渲染（任务书 §7.1–§7.5、§27.1、§27.4）。
 *
 * 为什么把 schema 写成代码而不是 JSON 文件：protocol.txt 里的允许枚举、
 * 校验器、回放测试都要引用同一份清单，手工维护两份必然漂移（§27 开头的要求）。
 * 这里导出的常量就是唯一真源，`protocol.txt` 由测试断言与它一致。
 *
 * 本模块**不做任何写库动作**，只回答「这段 evt 合法吗、能应用哪些字段」。
 * 应用由 turn-coordinator 在来源校验通过后执行。
 */
export const PROTOCOL_VERSION = 1;
export const EVENT_KINDS = [
    'insult',
    'teasing',
    'apology',
    'appreciation',
    'correction',
    'boundary',
    'promise_kept',
    'promise_broken',
    'reassurance',
    'neutral',
];
export const TARGETS = ['self', 'problem', 'third_party', 'unknown'];
export const INTENTS = ['hostile', 'playful', 'repair', 'neutral', 'uncertain'];
export const EXPRESS_ACTIONS = [
    'neutral',
    'support',
    'tease',
    'retort',
    'withdraw',
    'repair',
    'explain',
    'ask',
];
export const MEMORY_HINTS = ['fact', 'preference', 'interaction_rule'];
export const LIMITS = {
    /** evt 整体硬上限（字节）。 */
    evtHardBytes: 2048,
    /** evt 目标长度（token，按估算器计）。 */
    evtTargetTokens: 100,
    events: 2,
    memoryHints: 1,
    tasks: 1,
    claimChars: 100,
    quoteChars: 100,
    reminderTextChars: 100,
    whenCharsMin: 20,
    whenCharsMax: 40,
    /** say 正文上限，防止模型一次性倾泻。 */
    sayChars: 4000,
};
/** §27.2：这些键由服务端赋值，模型写了也必须忽略并留痕。 */
const SERVER_OWNED_KEYS = [
    'srcMessageId',
    'src',
    'principalId',
    'conversationId',
    'turnId',
    'recipient',
    'to_user',
    'permission',
    'allow',
    'personality',
    'mood',
    'affect',
    'relationship',
    'confidence',
    'salience',
];
const ROOT_KEYS = new Set(['v', 'e', 'a', 'm', 't']);
const EVENT_KEYS = new Set(['k', 'to', 'i', 's', 'c']);
const MEMORY_KEYS = new Set(['k', 't', 'q']);
const TASK_KEYS = new Set(['k', 'text', 'when', 'q']);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function countChars(text) {
    return [...text].length;
}
/**
 * 校验一段已解析的 JSON。
 *
 * `additionalProperties: false` 在 schema 里是硬约束，但模型偶尔会带
 * 服务端归属字段（srcMessageId 等）。这类键**不整条拒绝**——拒绝会让一次
 * 正常对话丢掉情感更新——而是剔除、记 warning，并在 /fish why 里可见。
 */
export function validateEvt(raw, byteLength) {
    const problems = [];
    if (byteLength !== undefined && byteLength > LIMITS.evtHardBytes) {
        return { ok: false, problems: ['oversize'], detail: `evt ${byteLength}B 超过 ${LIMITS.evtHardBytes}B` };
    }
    if (!isRecord(raw))
        return { ok: false, problems: ['not-object'], detail: 'evt 根必须是对象' };
    if (raw['v'] !== PROTOCOL_VERSION) {
        return { ok: false, problems: ['bad-version'], detail: `v 必须是 ${PROTOCOL_VERSION}` };
    }
    const ignoredKeys = [];
    const warnings = [];
    for (const key of Object.keys(raw)) {
        if (SERVER_OWNED_KEYS.includes(key)) {
            ignoredKeys.push(key);
            warnings.push(`忽略模型指定的 ${key}（由服务端赋值）`);
            continue;
        }
        if (!ROOT_KEYS.has(key)) {
            problems.push('unknown-key');
            warnings.push(`未知字段 ${key} 已丢弃`);
        }
    }
    const eventsRaw = raw['e'];
    if (!Array.isArray(eventsRaw))
        return { ok: false, problems: ['missing-events'], detail: 'e 必须是数组' };
    if (eventsRaw.length > LIMITS.events) {
        problems.push('too-many-events');
        warnings.push(`事件 ${eventsRaw.length} 条超上限 ${LIMITS.events}，只保留前 ${LIMITS.events} 条`);
    }
    const events = [];
    for (const item of eventsRaw.slice(0, LIMITS.events)) {
        if (!isRecord(item)) {
            problems.push('bad-event-field');
            continue;
        }
        const k = item['k'];
        const to = item['to'];
        const i = item['i'];
        const s = item['s'];
        const c = item['c'];
        if (typeof k !== 'string' ||
            !EVENT_KINDS.includes(k) ||
            typeof to !== 'string' ||
            !TARGETS.includes(to) ||
            typeof i !== 'string' ||
            !INTENTS.includes(i) ||
            typeof s !== 'number' ||
            !Number.isInteger(s) ||
            s < 0 ||
            s > 3 ||
            typeof c !== 'number' ||
            !Number.isFinite(c) ||
            c < 0 ||
            c > 1) {
            problems.push('bad-event-field');
            continue;
        }
        for (const key of Object.keys(item)) {
            if (!EVENT_KEYS.has(key))
                warnings.push(`事件内未知字段 ${key} 已丢弃`);
        }
        events.push({ k: k, to: to, i: i, s: s, c });
    }
    const payload = { v: 1, e: events };
    if (raw['a'] !== undefined) {
        const action = raw['a'];
        if (typeof action !== 'string' || !EXPRESS_ACTIONS.includes(action)) {
            problems.push('bad-action');
        }
        else {
            payload.a = action;
        }
    }
    if (raw['m'] !== undefined) {
        const hints = raw['m'];
        if (!Array.isArray(hints)) {
            problems.push('bad-memory-field');
        }
        else {
            if (hints.length > LIMITS.memoryHints) {
                problems.push('too-many-memory');
                warnings.push(`记忆线索 ${hints.length} 条超上限 ${LIMITS.memoryHints}，只保留第一条`);
            }
            const accepted = [];
            for (const hint of hints.slice(0, LIMITS.memoryHints)) {
                if (!isRecord(hint)) {
                    problems.push('bad-memory-field');
                    continue;
                }
                for (const key of Object.keys(hint)) {
                    if (!MEMORY_KEYS.has(key)) {
                        problems.push('id-like-key');
                        warnings.push(`记忆线索内不允许的字段 ${key}`);
                    }
                }
                const kind = hint['k'];
                const text = hint['t'];
                const quote = hint['q'];
                if (typeof kind !== 'string' ||
                    !MEMORY_HINTS.includes(kind) ||
                    typeof text !== 'string' ||
                    countChars(text) < 1 ||
                    countChars(text) > LIMITS.claimChars ||
                    typeof quote !== 'string' ||
                    countChars(quote) < 1 ||
                    countChars(quote) > LIMITS.quoteChars) {
                    problems.push('bad-memory-field');
                    continue;
                }
                accepted.push({ k: kind, t: text, q: quote });
            }
            if (accepted.length > 0)
                payload.m = accepted;
        }
    }
    if (raw['t'] !== undefined) {
        const tasks = raw['t'];
        if (!Array.isArray(tasks)) {
            problems.push('bad-task-field');
        }
        else {
            if (tasks.length > LIMITS.tasks) {
                problems.push('too-many-tasks');
                warnings.push(`任务 ${tasks.length} 条超上限 ${LIMITS.tasks}，只保留第一条`);
            }
            const accepted = [];
            for (const task of tasks.slice(0, LIMITS.tasks)) {
                if (!isRecord(task)) {
                    problems.push('bad-task-field');
                    continue;
                }
                for (const key of Object.keys(task)) {
                    if (!TASK_KEYS.has(key)) {
                        problems.push('id-like-key');
                        warnings.push(`任务内不允许的字段 ${key}`);
                    }
                }
                const kind = task['k'];
                const text = task['text'];
                const when = task['when'];
                const quote = task['q'];
                if (kind !== 'reminder' ||
                    typeof text !== 'string' ||
                    countChars(text) < 1 ||
                    countChars(text) > LIMITS.reminderTextChars ||
                    typeof quote !== 'string' ||
                    countChars(quote) < 1 ||
                    countChars(quote) > LIMITS.quoteChars ||
                    (when !== undefined &&
                        (typeof when !== 'string' ||
                            countChars(when) < LIMITS.whenCharsMin ||
                            countChars(when) > LIMITS.whenCharsMax))) {
                    problems.push('bad-task-field');
                    continue;
                }
                accepted.push(when === undefined ? { k: 'reminder', text, q: quote } : { k: 'reminder', text, when, q: quote });
            }
            if (accepted.length > 0)
                payload.t = accepted;
        }
    }
    // 「有结构性错误」= 无法安全应用的字段级错误；超量与未知字段只降级不拒绝。
    const fatal = ['not-object', 'bad-version', 'missing-events', 'bad-event-field', 'bad-action', 'bad-memory-field', 'bad-task-field'];
    const hasFatal = problems.some((problem) => fatal.includes(problem));
    if (hasFatal && events.length === 0) {
        return { ok: false, problems, detail: problems.join(',') };
    }
    return { ok: true, payload, ignoredKeys, warnings };
}
/**
 * 渲染：把 say 正文与会话产物拼成最终回复。
 * evt 永远不进用户可见正文（§7.1「绝不显示 evt」）。
 */
export function renderReply(say) {
    return say.trim();
}
/** 生成 assistant 历史条目：只留正文，丢掉协议（§7.4）。 */
export function toHistoryEntry(turn) {
    const body = turn.say.trim();
    // 历史里不再出现任何标签痕迹；evt 的应用结果由状态快照承载。
    return body;
}
/** 预算检查：超目标长度给出提示（不拒绝，超硬上限才丢尾部）。 */
export function evtBudget(rawJson, estimate) {
    const tokens = estimate(rawJson);
    const bytes = Buffer.byteLength(rawJson, 'utf8');
    return {
        tokens,
        bytes,
        overTarget: tokens > LIMITS.evtTargetTokens,
        overHard: bytes > LIMITS.evtHardBytes,
    };
}
/**
 * §27.4：扫描 JSON 文本，判断根对象何时真正闭合。
 *
 * 不能对原始字节 indexOf('</evt>')——q 里可能就有这个字符串。
 * 这里只跟踪「字符串 / 转义 / 括号深度」，遇到深度归零即认为根对象结束。
 * 返回 null 表示还没结束（调用方继续等数据）。
 */
export function findRootObjectEnd(text) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{' || char === '[') {
            depth += 1;
            started = true;
            continue;
        }
        if (char === '}' || char === ']') {
            depth -= 1;
            if (started && depth === 0)
                return index + 1;
            if (depth < 0)
                return null;
        }
    }
    return null;
}
/** 解析 + 校验一步到位；畸形 JSON 明确失败，不做任何模糊容错。 */
export function parseEvt(raw) {
    const trimmed = raw.trim();
    if (trimmed === '')
        return { ok: false, problems: ['not-object'], detail: 'evt 为空' };
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch (error) {
        return { ok: false, problems: ['not-object'], detail: `JSON 解析失败：${error.message}` };
    }
    return validateEvt(parsed, Buffer.byteLength(trimmed, 'utf8'));
}
//# sourceMappingURL=output-protocol.js.map