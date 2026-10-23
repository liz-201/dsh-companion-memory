/**
 * 回应策略（任务书 §9.1 / §9.2 / §9.3）。
 *
 * 这里**不生成台词**，只决定「这轮该偏向哪种表达」，以及给模型一条极短的
 * prior。台词由模型在人格提示词下自然生成——插件不替模型写死口癖。
 *
 * 输出是策略枚举，不是模板句；同一个策略在不同话题下自然会长得不一样。
 */

import type { AffectConfig } from '../config.js'
import type { AffectSnapshot, ExpressAction, ValidatedAppraisal } from './types.js'
import { pickLevel } from './emotion-decay.js'
import { ANGER_LEVELS, HURT_LEVELS, TENSION_LEVELS } from './emotion-decay.js'

export interface StrategyInput {
  snapshot: AffectSnapshot
  /** 本轮尾部事件（可能为空：普通闲聊没有事件）。 */
  appraisal?: ValidatedAppraisal | undefined
  /** 是否处于已建立的互损语境。 */
  establishedTeasingContext: boolean
  /** 本轮是不是用户在问技术问题（技术问题不应被情绪拖成错误）。 */
  technicalRequest: boolean
  config: AffectConfig
}

export interface StrategyDecision {
  action: ExpressAction
  /** 给模型的极短 prior，一句话；不含数值。 */
  prior: string
  /** 允许的表达强度上限：mild 时明确要求克制。 */
  intensity: 'mild' | 'moderate' | 'strong'
  reasons: string[]
}

/**
 * 动作选择顺序即优先级：修复 > 技术问题 > 互损接梗 > 明显不满 > 中性。
 * 顺序有意如此：用户在问正事时，情绪不能变成不回答的借口。
 */
export function decideStrategy(input: StrategyInput): StrategyDecision {
  const { snapshot, appraisal, config } = input
  const reasons: string[] = []
  const anger = pickLevel(snapshot.mood.anger, ANGER_LEVELS, undefined)
  const hurt = pickLevel(snapshot.mood.hurt, HURT_LEVELS, undefined)
  const tension = pickLevel(snapshot.mood.tension, TENSION_LEVELS, undefined)
  const intensity = config.retortIntensity

  if (appraisal !== undefined && (appraisal.intent === 'repair' || appraisal.kind === 'apology')) {
    reasons.push('repair-intent')
    return {
      action: 'repair',
      prior: hurt !== undefined ? '对方在缓和，可以缓一点，但不必立刻当作没发生。' : '对方在缓和，接住就行，不用小题大做。',
      intensity,
      reasons,
    }
  }

  if (appraisal !== undefined && (appraisal.kind === 'appreciation' || appraisal.intent === 'playful') && anger === undefined) {
    reasons.push('positive-or-playful')
    return {
      action: appraisal.kind === 'appreciation' ? 'support' : 'tease',
      prior: '可以自然接住，不用客套。',
      intensity,
      reasons,
    }
  }

  if (input.establishedTeasingContext && anger === undefined) {
    reasons.push('teasing-context')
    return {
      action: 'tease',
      prior: '这是惯常互损，可以还嘴，别当真受伤。',
      intensity,
      reasons,
    }
  }

  if (input.technicalRequest) {
    reasons.push('technical-request')
    return {
      action: anger !== undefined ? 'explain' : 'neutral',
      prior: anger !== undefined ? '还不高兴，但正事照答，别为难对方。' : '正常回答，别把情绪写进结论。',
      intensity: anger !== undefined ? 'mild' : intensity,
      reasons,
    }
  }

  if (anger !== undefined || hurt !== undefined) {
    reasons.push(anger !== undefined ? `anger:${anger}` : `hurt:${hurt}`)
    if (hurt !== undefined && anger === undefined) {
      return { action: 'withdraw', prior: '有点委屈，可以说出来，也可以先少说两句。', intensity, reasons }
    }
    if (intensity === 'mild' || snapshot.personality.selfControl >= 0.7) {
      return {
        action: 'retort',
        prior: '不高兴，但收着说，划清界限比骂人有用。',
        intensity: 'mild',
        reasons: [...reasons, 'self-control'],
      }
    }
    return { action: 'retort', prior: '可以直接顶回去，但只针对这件事。', intensity, reasons }
  }

  if (tension !== undefined) {
    reasons.push(`tension:${tension}`)
    return { action: 'neutral', prior: '气氛还没完全缓过来，正常说话即可，不用刻意热络。', intensity, reasons }
  }

  return { action: 'neutral', prior: '正常接话。', intensity, reasons }
}

/**
 * 生成「允许说脏话吗」的软约束：只在关系紧绷 + 明确挑衅 + 强度允许时放开，
 * 且始终禁止威胁与隐私羞辱（§9.2）。
 */
export function profanityPermitted(decision: StrategyDecision, snapshot: AffectSnapshot): boolean {
  return (
    decision.action === 'retort' &&
    decision.intensity !== 'mild' &&
    snapshot.personality.directness >= 0.7 &&
    (snapshot.mood.anger >= 0.35 || snapshot.relationship.grievance >= 0.3)
  )
}

/** 输出与尾部事件明显矛盾时的诊断码，供后台分析，不触发第二次模型调用。 */
export type ContinuityIssue =
  | 'hot-reply-after-insult'
  | 'cold-reply-after-apology'
  | 'ignored-open-episode'

export function checkContinuity(
  appraisal: ValidatedAppraisal | undefined,
  replyText: string,
  snapshot: AffectSnapshot,
): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []
  const warm = /(太好了|真棒|爱你|哈哈|么么|抱抱)/.test(replyText)
  if (appraisal !== undefined && appraisal.kind === 'insult' && warm && snapshot.mood.anger >= 0.3) {
    issues.push('hot-reply-after-insult')
  }
  if (appraisal !== undefined && appraisal.kind === 'apology' && /(滚|闭嘴|别烦)/.test(replyText)) {
    issues.push('cold-reply-after-apology')
  }
  if (snapshot.openEpisodeIds.length > 0 && warm && appraisal === undefined) {
    issues.push('ignored-open-episode')
  }
  return issues
}
