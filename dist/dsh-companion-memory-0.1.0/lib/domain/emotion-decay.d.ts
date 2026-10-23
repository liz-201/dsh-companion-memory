/**
 * 时间衰减（任务书 §8.3）。
 *
 * x(now) = baseline + (x(last) - baseline) * 2^(-(now-last)/halfLife)
 *
 * 只做纯计算：读取时按需衰减，收到真实事件后再持久提交。没有「每分钟 tick
 * 写一条状态事件」的路径，也没有隐式 Date.now()——时间一律由参数传入。
 */
import type { Mood, Relationship } from './types.js';
export declare const MOOD_BASELINE: Mood;
export declare const MOOD_HALF_LIFE_MINUTES: Record<keyof Mood, number>;
/**
 * trust / respect / affection 没有人联系时**不自动降低也不自动恢复**；
 * grievance 只由 episode 解决、修复事件与非常缓慢的显著性衰减改变。
 * 这里给 grievance 一个很长的半衰期基线，且默认不启用（见 decayGrievance）。
 */
export declare const GRIEVANCE_HALF_LIFE_MINUTES: number;
export declare function decayValue(value: number, baseline: number, halfLifeMinutes: number, elapsedMs: number): number;
export interface DecayOptions {
    halfLifeMinutes?: Partial<Record<keyof Mood, number>>;
    /** 是否允许 grievance 的显著性衰减；默认 false（无新证据不放大也不自动抹平）。 */
    decayGrievance?: boolean;
    grievanceHalfLifeMinutes?: number;
}
export declare function decayMood(mood: Mood, elapsedMs: number, options?: DecayOptions): Mood;
export declare function decayRelationship(relationship: Relationship, elapsedMs: number, options?: DecayOptions): Relationship;
/** 阈值滞后：进入与退出用不同门槛，避免四舍五入导致每轮跳变。 */
export interface HysteresisLevel {
    readonly enter: number;
    readonly exit: number;
    readonly label: string;
}
export declare const ANGER_LEVELS: readonly HysteresisLevel[];
export declare const HURT_LEVELS: readonly HysteresisLevel[];
export declare const TENSION_LEVELS: readonly HysteresisLevel[];
export declare const AFFECTION_LEVELS: readonly HysteresisLevel[];
export declare const TRUST_LEVELS: readonly HysteresisLevel[];
/**
 * 稳定地选中一个等级：只有超过 enter 才升档，低于 exit 才降档；两者之间
 * 保持 previousLabel。previousLabel 为 undefined 时按 enter 判定。
 */
export declare function pickLevel(value: number, levels: readonly HysteresisLevel[], previousLabel: string | undefined): string | undefined;
export declare function clamp(value: number, min?: number, max?: number): number;
export declare function round3(value: number): number;
