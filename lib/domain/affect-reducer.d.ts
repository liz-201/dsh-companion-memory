/**
 * 纯 reducer（任务书 §8.6 / §8.7 / §8.8）。
 *
 * 输入一律显式：previousState、validatedEvent、clock、config。函数内部不读
 * Date.now()、不碰数据库、不发网络请求，因此同一组输入永远得到同一份输出，
 * 回放与单测可以直接比对。
 *
 * 事件流：校验 → 按事件时间衰减 → 归类门槛 → 计算增量 → 扣 episode 差额
 * → 撞日上限 → 夹紧范围 → 产出新状态 + 解释码。
 */
import type { AffectConfig } from '../config.js';
import type { AffectSnapshot, Clock, EventKind, Mood, Personality, Relationship, ValidatedAppraisal } from './types.js';
import type { RelationshipDelta } from './types.js';
export declare const PRESETS: Readonly<Record<'irritable' | 'balanced' | 'gentle', Personality>>;
export declare const INITIAL_RELATIONSHIP: Relationship;
export declare const INITIAL_MOOD: Mood;
export interface EpisodeContext {
    id: string;
    kind: EventKind;
    status: 'open' | 'repairing' | 'resolved' | 'archived';
    lastEventAtMs: number;
    uniqueMessageCount: number;
    /** 本 episode 已经实际施加到关系上的累计变化。 */
    appliedDeltas: RelationshipDelta;
}
export interface ReduceContext {
    /** 当天（按事件本地日期）已经用掉的绝对变化额度，用于 §8.6 日上限。 */
    dailyUsed: RelationshipDelta;
    /** 可能合并的 open/repairing episode；没有则 undefined。 */
    episode?: EpisodeContext | undefined;
    fromInboundUserMessage: boolean;
    establishedTeasingContext: boolean;
    roleplay: boolean;
    /** 每轮只允许一次幂等；重复事件返回 sameAsPrevious。 */
    idempotencyKey: string;
    seenIdempotencyKeys: ReadonlySet<string>;
}
export type ExplanationCode = 'ok' | 'skip:duplicate' | 'skip:not-inbound-user-message' | 'skip:roleplay-scope' | 'skip:target-not-self' | 'skip:low-hostile-confidence' | 'skip:established-teasing' | 'mood-only:soft' | 'episode:merged' | 'episode:opened' | 'episode:repairing' | 'cap:daily' | 'clamp:range';
export interface ReduceResult {
    next: AffectSnapshot;
    explanations: ExplanationCode[];
    /** 需要落库的 episode 变更（新建或累计更新）。 */
    episode: EpisodeContext & {
        isNew: boolean;
        deltaToApply: RelationshipDelta;
    };
    moodOnly: boolean;
    scale: number;
    reasons: string[];
}
export interface ReduceEvent extends ValidatedAppraisal {
    occurredAtMs: number;
}
export declare function initialSnapshot(principalId: string, preset: keyof typeof PRESETS, ruleVersion: string, nowMs: number): AffectSnapshot;
/**
 * 只做衰减的读取投影：用于「这一轮没有任何新事件，但需要向模型报告当前
 * 状态」。不写库、不改 revision。
 */
export declare function projectSnapshot(snapshot: AffectSnapshot, nowMs: number, config: AffectConfig): AffectSnapshot;
export declare function reduce(previous: AffectSnapshot, event: ReduceEvent, clock: Clock, config: AffectConfig, context: ReduceContext): ReduceResult;
export interface StateSummary {
    relationshipLevels: string;
    moodLevels: string;
    episodeHint: string;
    rules: string;
}
/**
 * 把状态压成给人看的等级（§11.3 动态状态模板）。只用等级不用数值，
 * 阈值滞后避免四舍五入导致每轮跳变。
 */
export declare function summarizeState(snapshot: AffectSnapshot, previousSummary?: StateSummary): StateSummary;
