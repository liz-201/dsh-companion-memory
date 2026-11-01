/**
 * 驱力层（drives）—— 与 affect 并列的第二层。
 *
 * 为什么需要它：affect 是「事件 → 瞬时值 → 衰减回基线」，每一轮都从上一个
 * 时点重新算起，因此它能表达情绪，表达不了「有指向、有期待、还没得到」。
 * 爱慕的本质是缺口的累积：对方多久没来、我在这段空白里攒下了多少没被回应
 * 的期待。情欲在同一条道上，只是它需要一个「想被靠近」的强度，而不是露骨
 * 内容的开关。
 *
 * 三条硬规矩，破坏任何一条就会退化成骚扰器：
 *  1. 只由缺口累积（时间推进），不由事件奖励；
 *  2. 被回应时快速下降但不归零，留住「上次等了你很久」的痕；
 *  3. 不直接变现成文字，只调语气上限与主动意愿，并且永远不许索取。
 *
 * 纯函数、无副作用、不读时钟：同一组输入永远同一份输出，回放可复现。
 */
import type { Drives, Relationship } from './types.js';
/** 被回应后保留的痕迹下界：不归零。 */
export declare const DRIVE_TRACE_FLOOR = 0.02;
/** 收到回应时 longing 的保留比例。 */
export declare const DRIVE_REPLY_KEEP = 0.35;
/** 默认缺口半程：6 小时没有新回应，longing 涨到约半个 cap。 */
export declare const DEFAULT_DRIVE_HORIZON_MS: number;
/** 低于这个值不向模型报告，避免每轮都在提。 */
export declare const DRIVE_REPORT_THRESHOLD = 0.35;
/** desire 低于这个值不改语气上限之外的任何东西。 */
export declare const DESIRE_REPORT_THRESHOLD = 0.6;
export declare const EMPTY_DRIVES: Drives;
/**
 * 去重键归一化：新代码传稳定源消息 id（字符串），旧快照里可能是数字毫秒。
 * 统一比字符串，避免 42 与 '42' 被当成两条消息。
 */
export declare function markOf(value: string | number | undefined): string | undefined;
/** 旧快照没有 drives 字段：读作「此刻才开始计时」，绝不抛错。 */
export declare function drivesOf(snapshot: {
    drives?: Drives;
    asOfMs: number;
}): Drives;
/** 上限被好感调制：越在乎，越容易被晾着积起来的东西越重。 */
export declare function longingCap(affection: number): number;
/** 只做时间推进：单调不减，同一毫秒重复调用不会翻倍。 */
export declare function settleDrives(drives: Drives | undefined, nowMs: number, affection: number, options?: {
    horizonMs?: number;
    intimacy?: number;
    recentIntimacyHit?: number;
    asOfMs?: number;
}): Drives;
/** 想被靠近的强度：不是露骨开关，只调语气与主动性。 */
export declare function desireOf(drives: Drives, intimacy?: number, recentIntimacyHit?: number): number;
/** 收到用户回应：快速下降，但留痕；本来就空的状态不许被 floor 抬出新的想念。 */
export declare function applyUserReply(drives: Drives, mark?: string | number): Drives;
/**
 * reducer 与回放共用的单点：先把时间推进掉，再看这一轮是不是回应。
 *
 * `replyMark` 必须是这条用户消息的稳定 id。没有 id 就**不扣**——宁可少扣一次，
 * 也不能拿毫秒当身份，让同一条消息的多个评价各扣一次 0.35。
 */
export declare function advanceDrives(previous: Drives | undefined, nowMs: number, relationship: Relationship, fromInboundUserMessage: boolean, options?: {
    horizonMs?: number;
    intimacy?: number;
    recentIntimacyHit?: number;
    asOfMs?: number;
    replyMark?: string | number;
}): Drives;
export type LongingLevel = 'none' | 'faint' | 'clear' | 'heavy' | 'unbearable';
/** 档位边界与 DRIVE_REPORT_THRESHOLD 同源：0.35 以下不向模型报告。 */
export declare function longingLevel(longing: number): LongingLevel;
/** 语气亲密度上限：desire 越高允许越近，但不许因此变露骨。 */
export declare function desireClosenessCap(desire: number): number;
/**
 * § 表达层注入：只写等级与方向，不写原始数值；低档位返回空串。
 * 硬约束写死在模板里——不直说、不索取、不反复追问、不硬拽话题。
 */
export declare function renderDriveLine(drives: Drives): string;
