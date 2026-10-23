/**
 * 回应策略（任务书 §9.1 / §9.2 / §9.3）。
 *
 * 这里**不生成台词**，只决定「这轮该偏向哪种表达」，以及给模型一条极短的
 * prior。台词由模型在人格提示词下自然生成——插件不替模型写死口癖。
 *
 * 输出是策略枚举，不是模板句；同一个策略在不同话题下自然会长得不一样。
 */
import type { AffectConfig } from '../config.js';
import type { AffectSnapshot, ExpressAction, ValidatedAppraisal } from './types.js';
export interface StrategyInput {
    snapshot: AffectSnapshot;
    /** 本轮尾部事件（可能为空：普通闲聊没有事件）。 */
    appraisal?: ValidatedAppraisal | undefined;
    /** 是否处于已建立的互损语境。 */
    establishedTeasingContext: boolean;
    /** 本轮是不是用户在问技术问题（技术问题不应被情绪拖成错误）。 */
    technicalRequest: boolean;
    config: AffectConfig;
}
export interface StrategyDecision {
    action: ExpressAction;
    /** 给模型的极短 prior，一句话；不含数值。 */
    prior: string;
    /** 允许的表达强度上限：mild 时明确要求克制。 */
    intensity: 'mild' | 'moderate' | 'strong';
    reasons: string[];
}
/**
 * 动作选择顺序即优先级：修复 > 技术问题 > 互损接梗 > 明显不满 > 中性。
 * 顺序有意如此：用户在问正事时，情绪不能变成不回答的借口。
 */
export declare function decideStrategy(input: StrategyInput): StrategyDecision;
/**
 * 生成「允许说脏话吗」的软约束：只在关系紧绷 + 明确挑衅 + 强度允许时放开，
 * 且始终禁止威胁与隐私羞辱（§9.2）。
 */
export declare function profanityPermitted(decision: StrategyDecision, snapshot: AffectSnapshot): boolean;
/** 输出与尾部事件明显矛盾时的诊断码，供后台分析，不触发第二次模型调用。 */
export type ContinuityIssue = 'hot-reply-after-insult' | 'cold-reply-after-apology' | 'ignored-open-episode';
export declare function checkContinuity(appraisal: ValidatedAppraisal | undefined, replyText: string, snapshot: AffectSnapshot): ContinuityIssue[];
