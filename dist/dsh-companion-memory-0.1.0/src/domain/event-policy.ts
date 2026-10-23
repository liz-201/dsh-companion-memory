/**
 * 情境归因门槛与事件权重（任务书 §8.4 / §8.5 / §8.6）。
 *
 * 这一层只做**判定与换算**，不改状态；真正的状态推进在 affect-reducer。
 */

import type { AffectConfig } from '../config.js'
import type { EventKind, Intent, Personality, Relationship, Target, ValidatedAppraisal } from './types.js'
import { clamp } from './emotion-decay.js'

export interface EventBaseWeights {
  affection: number
  trust: number
  respect: number
  grievance: number
  anger: number
  hurt: number
  joy: number
  tension: number
}

const ZERO: EventBaseWeights = {
  affection: 0,
  trust: 0,
  respect: 0,
  grievance: 0,
  anger: 0,
  hurt: 0,
  joy: 0,
  tension: 0,
}

/**
 * §8.5 初始权重表：severity=3、confidence=1、明确相关时的一次事件基准。
 * 全部是待调工程参数，不宣称来自人格测量。
 */
export const EVENT_WEIGHTS: Readonly<Record<EventKind, EventBaseWeights>> = {
  insult: { ...ZERO, affection: -0.025, trust: -0.01, respect: -0.04, grievance: 0.05, anger: 0.3, hurt: 0.1 },
  promise_broken: { ...ZERO, affection: -0.01, trust: -0.06, respect: -0.015, grievance: 0.035, anger: 0.1, hurt: 0.15 },
  promise_kept: { ...ZERO, affection: 0.01, trust: 0.03, respect: 0.015, grievance: -0.01, anger: -0.03, hurt: -0.02, joy: 0.06 },
  appreciation: { ...ZERO, affection: 0.015, trust: 0.005, respect: 0.005, anger: -0.05, hurt: -0.02, joy: 0.1 },
  apology: { ...ZERO, affection: 0.01, respect: 0.01, grievance: -0.025, anger: -0.2, hurt: -0.08, joy: 0.02 },
  reassurance: { ...ZERO, trust: 0.01, hurt: -0.05, anger: -0.04, tension: -0.06 },
  teasing: { ...ZERO, affection: 0.003, joy: 0.03 },
  correction: { ...ZERO },
  boundary: { ...ZERO, respect: 0.005, grievance: 0.01, tension: 0.02 },
  neutral: { ...ZERO },
}

export interface EligibilityInput {
  appraisal: Pick<ValidatedAppraisal, 'kind' | 'intent' | 'target' | 'severity' | 'confidence' | 'source'>
  /** 必须来自真实入站用户消息；内部状态与助手输出不得形成长期结论。 */
  fromInboundUserMessage: boolean
  /** 已建立且当前仍成立的互损语境。 */
  establishedTeasingContext: boolean
  /** 角色扮演虚构人物（默认不改变真实用户关系）。 */
  roleplay: boolean
}

export type EligibilityReason =
  | 'ok'
  | 'not_inbound_user_message'
  | 'roleplay_scope'
  | 'target_not_self'
  | 'low_hostile_confidence'
  | 'established_teasing'

export interface EligibilityResult {
  eligible: boolean
  reason: EligibilityReason
  /** 允许产生「当下轻微不快」，但不形成强烈长期恶意结论。 */
  softMoodOnly: boolean
}

/**
 * §8.4 五个门槛。长期负面更新必须同时满足；不满足时最多只影响当下心情。
 */
export function checkEligibility(input: EligibilityInput, config: AffectConfig): EligibilityResult {
  const { appraisal } = input
  if (!input.fromInboundUserMessage) {
    return { eligible: false, reason: 'not_inbound_user_message', softMoodOnly: false }
  }
  if (input.roleplay) {
    return { eligible: false, reason: 'roleplay_scope', softMoodOnly: false }
  }
  // 明确指向鱼才可能属于关系事件；骂报错、第三方、引用都不算。
  if (appraisal.target !== 'self' && appraisal.intent !== 'repair') {
    return { eligible: false, reason: 'target_not_self', softMoodOnly: false }
  }
  const hostile = appraisal.intent === 'hostile' || appraisal.kind === 'insult'
  if (hostile && appraisal.confidence < config.hostileConfidenceThreshold) {
    return { eligible: false, reason: 'low_hostile_confidence', softMoodOnly: true }
  }
  if (input.establishedTeasingContext && (appraisal.kind === 'teasing' || hostile)) {
    return { eligible: false, reason: 'established_teasing', softMoodOnly: true }
  }
  return { eligible: true, reason: 'ok', softMoodOnly: false }
}

/**
 * scale = (severity/3) * confidence；之后按人格与情境放大，但 confidence
 * 只乘一次（§8.6 明确禁止重复相乘导致强事件几乎无效果）。
 */
export function baseScale(appraisal: Pick<ValidatedAppraisal, 'severity' | 'confidence'>): number {
  return (appraisal.severity / 3) * clamp(appraisal.confidence, 0, 1)
}

export interface MoodDelta {
  anger: number
  hurt: number
  joy: number
  tension: number
  expressiveness: number
}

export interface ScaledEffect {
  relationship: Pick<EventBaseWeights, 'affection' | 'trust' | 'respect' | 'grievance'>
  mood: MoodDelta
  scale: number
  reasons: string[]
}

/**
 * 把一次事件换算成实际增量。
 * - 怒气受易怒度放大。
 * - 委屈受敏感度、亲近度与信任度放大（越亲近的明确攻击越委屈，§8.2）。
 * - 自控度压制「表达」而不压制「感受」：expressiveness 增量按自控缩小。
 * - 负向与正向情绪分别使用不同增益，保证道歉能真正降低怒气。
 */
export function scaleEffect(
  appraisal: ValidatedAppraisal,
  personality: Personality,
  relationship: Relationship,
  config: AffectConfig,
): ScaledEffect {
  const base = EVENT_WEIGHTS[appraisal.kind] ?? ZERO
  const scale = baseScale(appraisal)
  const reasons: string[] = [`scale=${scale.toFixed(3)}`, `kind=${appraisal.kind}`]

  const angerGain = 0.5 + personality.irritability
  const hurtGain = 0.5 + personality.sensitivity + 0.4 * Math.max(relationship.affection, 0) + 0.2 * relationship.trust
  const positiveGain = 0.6 + 0.6 * personality.warmth
  const negativeMood = base.anger < 0 || base.hurt < 0
  const expressiveGain = negativeMood ? 1 : 1 - 0.5 * personality.selfControl

  if (angerGain !== 1) reasons.push(`angerGain=${angerGain.toFixed(3)}`)
  if (hurtGain !== 1) reasons.push(`hurtGain=${hurtGain.toFixed(3)}`)

  // 正向事件不要被「易怒度」放大；负向事件也不要被「亲和」放大。
  const moodGain = (value: number): number => (value >= 0 ? positiveGain : 1)

  const relationshipEffect = {
    affection: base.affection * scale * (base.affection >= 0 ? positiveGain : 1),
    trust: base.trust * scale * (base.trust >= 0 ? positiveGain : 1),
    respect: base.respect * scale * (base.respect >= 0 ? positiveGain : 1),
    grievance: base.grievance * scale * (base.grievance > 0 ? 0.5 + personality.sensitivity : 1),
  }

  const mood: MoodDelta = {
    anger: base.anger < 0
      ? base.anger * scale * moodGain(base.anger)
      : base.anger * scale * angerGain,
    hurt: base.hurt < 0
      ? base.hurt * scale * moodGain(base.hurt)
      : base.hurt * scale * hurtGain,
    joy: base.joy * scale * moodGain(base.joy),
    tension: base.tension * scale,
    expressiveness: (base.anger > 0 ? base.anger * 0.35 : base.anger * 0.2) * scale * expressiveGain,
  }

  // 自控高时表达克制：把「表达冲动」换成少量 tension，避免无处释放又不动声色。
  if (base.anger > 0 && personality.selfControl > 0.5) {
    const suppressed = base.anger * 0.35 * scale * 0.5 * personality.selfControl
    mood.expressiveness -= suppressed * 0.5
    mood.tension += suppressed * 0.6
    reasons.push('selfControl-suppression')
  }

  if (config.retortIntensity === 'mild') {
    mood.expressiveness *= 0.7
    reasons.push('retortIntensity=mild')
  } else if (config.retortIntensity === 'strong') {
    mood.expressiveness *= 1.2
    reasons.push('retortIntensity=strong')
  }

  return { relationship: relationshipEffect, mood, scale, reasons }
}

/**
 * §8.7 连续争执合并：同一用户、同一指向、相近主题，间隔不足 gap 分钟合并
 * 为一个 episode；重复只给少量增益，最高 1.5 倍，保证不会无限扣分。
 */
export function repeatMultiplier(uniqueMessageCount: number): number {
  const n = Math.max(1, Math.floor(uniqueMessageCount))
  return Math.min(1.5, 1 + 0.1 * Math.min(n - 1, 5))
}

export function isSameConflictEpisode(
  lastEventAtMs: number,
  nowMs: number,
  kind: EventKind,
  target: Target,
  gapMinutes: number,
): boolean {
  if (!Number.isFinite(lastEventAtMs)) return false
  const gapMs = Math.max(0, gapMinutes) * 60_000
  const withinGap = nowMs - lastEventAtMs <= gapMs
  if (!withinGap) return false
  return target === 'self' && (kind === 'insult' || kind === 'boundary' || kind === 'teasing')
}

/** 单日绝对变化上限（§8.6），防止刷屏或重复提取把关系推满。 */
export function applyDailyCaps(
  delta: Pick<EventBaseWeights, 'affection' | 'trust' | 'respect' | 'grievance'>,
  usedToday: Pick<EventBaseWeights, 'affection' | 'trust' | 'respect' | 'grievance'>,
  caps: AffectConfig['dailyAbsoluteDeltaCaps'],
): { applied: typeof delta; clipped: string[] } {
  const clipped: string[] = []
  const limit = (field: keyof typeof caps, value: number): number => {
    const used = usedToday[field]
    const cap = caps[field]
    const remaining = value >= 0 ? Math.max(0, cap - Math.max(0, used)) : Math.max(0, cap + Math.min(0, used))
    if (Math.abs(value) > remaining) {
      clipped.push(`${field}:${value.toFixed(4)}->${(value >= 0 ? remaining : -remaining).toFixed(4)}`)
      return value >= 0 ? remaining : -remaining
    }
    return value
  }
  return {
    applied: {
      affection: limit('affection', delta.affection),
      trust: limit('trust', delta.trust),
      respect: limit('respect', delta.respect),
      grievance: limit('grievance', delta.grievance),
    },
    clipped,
  }
}

/** 意图是否属于「修复」类，用于把 open episode 推进到 repairing。 */
export function isRepairIntent(intent: Intent, kind: EventKind): boolean {
  return intent === 'repair' || kind === 'apology' || kind === 'promise_kept' || kind === 'reassurance'
}
