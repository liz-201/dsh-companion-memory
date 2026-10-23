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
import type { EventKind, ExpressAction, Intent, MemoryKind, Target } from '../domain/types.js';
export declare const PROTOCOL_VERSION = 1;
export declare const EVENT_KINDS: readonly EventKind[];
export declare const TARGETS: readonly Target[];
export declare const INTENTS: readonly Intent[];
export declare const EXPRESS_ACTIONS: readonly ExpressAction[];
export declare const MEMORY_HINTS: readonly MemoryKind[];
export declare const LIMITS: {
    /** evt 整体硬上限（字节）。 */
    readonly evtHardBytes: 2048;
    /** evt 目标长度（token，按估算器计）。 */
    readonly evtTargetTokens: 100;
    readonly events: 2;
    readonly memoryHints: 1;
    readonly tasks: 1;
    readonly claimChars: 100;
    readonly quoteChars: 100;
    readonly reminderTextChars: 100;
    readonly whenCharsMin: 20;
    readonly whenCharsMax: 40;
    /** say 正文上限，防止模型一次性倾泻。 */
    readonly sayChars: 4000;
};
export interface EventRecord {
    k: EventKind;
    to: Target;
    i: Intent;
    s: 0 | 1 | 2 | 3;
    c: number;
}
export interface MemoryHint {
    k: MemoryKind;
    t: string;
    q: string;
}
export interface ReminderHint {
    k: 'reminder';
    text: string;
    when?: string;
    q: string;
}
export interface EvtPayload {
    v: 1;
    e: EventRecord[];
    a?: ExpressAction;
    m?: MemoryHint[];
    t?: ReminderHint[];
}
export type EvtProblem = 'not-object' | 'bad-version' | 'unknown-key' | 'missing-events' | 'too-many-events' | 'bad-event-field' | 'bad-action' | 'too-many-memory' | 'bad-memory-field' | 'too-many-tasks' | 'bad-task-field' | 'id-like-key' | 'oversize';
export interface EvtValidationOk {
    ok: true;
    payload: EvtPayload;
    /** 应用时必须忽略的键（模型越权指定归属）。 */
    ignoredKeys: string[];
    warnings: string[];
}
export interface EvtValidationFail {
    ok: false;
    problems: EvtProblem[];
    detail: string;
}
export type EvtValidation = EvtValidationOk | EvtValidationFail;
/**
 * 校验一段已解析的 JSON。
 *
 * `additionalProperties: false` 在 schema 里是硬约束，但模型偶尔会带
 * 服务端归属字段（srcMessageId 等）。这类键**不整条拒绝**——拒绝会让一次
 * 正常对话丢掉情感更新——而是剔除、记 warning，并在 /fish why 里可见。
 */
export declare function validateEvt(raw: unknown, byteLength?: number): EvtValidation;
/**
 * 渲染：把 say 正文与会话产物拼成最终回复。
 * evt 永远不进用户可见正文（§7.1「绝不显示 evt」）。
 */
export declare function renderReply(say: string): string;
/** 生成 assistant 历史条目：只留正文，丢掉协议（§7.4）。 */
export declare function toHistoryEntry(turn: {
    say: string;
    evtApplied: boolean;
}): string;
/** 预算检查：超目标长度给出提示（不拒绝，超硬上限才丢尾部）。 */
export declare function evtBudget(rawJson: string, estimate: (text: string) => number): {
    tokens: number;
    bytes: number;
    overTarget: boolean;
    overHard: boolean;
};
/**
 * §27.4：扫描 JSON 文本，判断根对象何时真正闭合。
 *
 * 不能对原始字节 indexOf('</evt>')——q 里可能就有这个字符串。
 * 这里只跟踪「字符串 / 转义 / 括号深度」，遇到深度归零即认为根对象结束。
 * 返回 null 表示还没结束（调用方继续等数据）。
 */
export declare function findRootObjectEnd(text: string): number | null;
/** 解析 + 校验一步到位；畸形 JSON 明确失败，不做任何模糊容错。 */
export declare function parseEvt(raw: string): EvtValidation;
