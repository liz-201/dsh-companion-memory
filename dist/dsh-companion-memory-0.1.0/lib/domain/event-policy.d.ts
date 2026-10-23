/**
 * 情境归因门槛与事件权重（任务书 §8.4 / §8.5 / §8.6）。
 *
 * 这一层只做**判定与换算**，不改状态；真正的状态推进在 affect-reducer。
 */
import type { AffectConfig } from '../config.js';
import type { EventKind, Intent, Personality, Relationship, Target, ValidatedAppraisal } from './types.js';
export interface EventBaseWeights {
    affection: number;
    trust: number;
    respect: number;
    grievance: number;
    anger: number;
    hurt: number;
    joy: number;
    tension: number;
}
/**
 * §8.5 初始权重表：severity=3、confidence=1、明确相关时的一次事件基准。
 * 全部是待调工程参数，不宣称来自人格测量。
 */
export declare const EVENT_WEIGHTS: Readonly<Record<EventKind, EventBaseWeights>>;
export interface EligibilityInput {
    appraisal: Pick<ValidatedAppraisal, 'kind' | 'intent' | 'target' | 'severity' | 'confidence' | 'source'>;
    /** 必须来自真实入站用户消息；内部状态与助手输出不得形成长期结论。 */
    fromInboundUserMessage: boolean;
    /** 已建立且当前仍成立的互损语境。 */
    establishedTeasingContext: boolean;
    /** 角色扮演虚构人物（默认不改变真实用户关系）。 */
    roleplay: boolean;
}
export type EligibilityReason = 'ok' | 'not_inbound_user_message' | 'roleplay_scope' | 'target_not_self' | 'low_hostile_confidence' | 'established_teasing';
export interface EligibilityResult {
    eligible: boolean;
    reason: EligibilityReason;
    /** 允许产生「当下轻微不快」，但不形成强烈长期恶意结论。 */
    softMoodOnly: boolean;
}
/**
 * §8.4 五个门槛。长期负面更新必须同时满足；不满足时最多只影响当下心情。
 */
export declare function checkEligibility(input: EligibilityInput, config: AffectConfig): EligibilityResult;
/**
 * scale = (severity/3) * confidence；之后按人格与情境放大，但 confidence
 * 只乘一次（§8.6 明确禁止重复相乘导致强事件几乎无效果）。
 */
export declare function baseScale(appraisal: Pick<ValidatedAppraisal, 'severity' | 'confidence'>): number;
export interface MoodDelta {
    anger: number;
    hurt: number;
    joy: number;
    tension: number;
    expressiveness: number;
}
export interface ScaledEffect {
    relationship: Pick<EventBaseWeights, 'affection' | 'trust' | 'respect' | 'grievance'>;
    mood: MoodDelta;
    scale: number;
    reasons: string[];
}
/**
 * 把一次事件换算成实际增量。
 * - 怒气受易怒度放大。
 * - 委屈受敏感度、亲近度与信任度放大（越亲近的明确攻击越委屈，§8.2）。
 * - 自控度压制「表达」而不压制「感受」：expressiveness 增量按自控缩小。
 * - 负向与正向情绪分别使用不同增益，保证道歉能真正降低怒气。
 */
export declare function scaleEffect(appraisal: ValidatedAppraisal, personality: Personality, relationship: Relationship, config: AffectConfig): ScaledEffect;
/**
 * §8.7 连续争执合并：同一用户、同一指向、相近主题，间隔不足 gap 分钟合并
 * 为一个 episode；重复只给少量增益，最高 1.5 倍，保证不会无限扣分。
 */
export declare function repeatMultiplier(uniqueMessageCount: number): number;
export declare function isSameConflictEpisode(lastEventAtMs: number, nowMs: number, kind: EventKind, target: Target, gapMinutes: number): boolean;
/** 单日绝对变化上限（§8.6），防止刷屏或重复提取把关系推满。 */
export declare function applyDailyCaps(delta: Pick<EventBaseWeights, 'affection' | 'trust' | 'respect' | 'grievance'>, usedToday: Pick<EventBaseWeights, 'affection' | 'trust' | 'respect' | 'grievance'>, caps: AffectConfig['dailyAbsoluteDeltaCaps']): {
    applied: typeof delta;
    clipped: string[];
};
/** 意图是否属于「修复」类，用于把 open episode 推进到 repairing。 */
export declare function isRepairIntent(intent: Intent, kind: EventKind): boolean;
