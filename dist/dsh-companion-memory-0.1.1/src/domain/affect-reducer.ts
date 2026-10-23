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

import type { AffectConfig } from '../config.js'
import type {
  AffectSnapshot,
  Clock,
  EventKind,
  Mood,
  Personality,
  Relationship,
  Target,
  ValidatedAppraisal,
} from './types.js'
import { clamp, decayMood, decayRelationship, pickLevel, round3 } from './emotion-decay.js'
import {
  ANGER_LEVELS,
  AFFECTION_LEVELS,
  HURT_LEVELS,
  TENSION_LEVELS,
  TRUST_LEVELS,
} from './emotion-decay.js'
import { applyDailyCaps, checkEligibility, isRepairIntent, isSameConflictEpisode, repeatMultiplier, scaleEffect } from './event-policy.js'
import type { RelationshipDelta } from './types.js'

export const PRESETS: Readonly<Record<'irritable' | 'balanced' | 'gentle', Personality>> = {
  irritable: { irritability: 0.8, sensitivity: 0.6, directness: 0.85, selfControl: 0.35, warmth: 0.5, initiative: 0.5 },
  balanced: { irritability: 0.4, sensitivity: 0.45, directness: 0.6, selfControl: 0.65, warmth: 0.6, initiative: 0.5 },
  gentle: { irritability: 0.2, sensitivity: 0.6, directness: 0.45, selfControl: 0.85, warmth: 0.8, initiative: 0.4 },
}

export const INITIAL_RELATIONSHIP: Relationship = {
  affection: 0.15,
  trust: 0.5,
  respect: 0.6,
  familiarity: 0.1,
  grievance: 0,
}

export const INITIAL_MOOD: Mood = {
  anger: 0,
  hurt: 0,
  joy: 0.1,
  tension: 0.05,
  expressiveness: 0.4,
}

export interface EpisodeContext {
  id: string
  kind: EventKind
  status: 'open' | 'repairing' | 'resolved' | 'archived'
  lastEventAtMs: number
  uniqueMessageCount: number
  /** 本 episode 已经实际施加到关系上的累计变化。 */
  appliedDeltas: RelationshipDelta
}

export interface ReduceContext {
  /** 当天（按事件本地日期）已经用掉的绝对变化额度，用于 §8.6 日上限。 */
  dailyUsed: RelationshipDelta
  /** 可能合并的 open/repairing episode；没有则 undefined。 */
  episode?: EpisodeContext | undefined
  fromInboundUserMessage: boolean
  establishedTeasingContext: boolean
  roleplay: boolean
  /** 每轮只允许一次幂等；重复事件返回 sameAsPrevious。 */
  idempotencyKey: string
  seenIdempotencyKeys: ReadonlySet<string>
}

export type ExplanationCode =
  | 'ok'
  | 'skip:duplicate'
  | 'skip:not-inbound-user-message'
  | 'skip:roleplay-scope'
  | 'skip:target-not-self'
  | 'skip:low-hostile-confidence'
  | 'skip:established-teasing'
  | 'mood-only:soft'
  | 'episode:merged'
  | 'episode:opened'
  | 'episode:repairing'
  | 'cap:daily'
  | 'clamp:range'

export interface ReduceResult {
  next: AffectSnapshot
  explanations: ExplanationCode[]
  /** 需要落库的 episode 变更（新建或累计更新）。 */
  episode: EpisodeContext & { isNew: boolean; deltaToApply: RelationshipDelta }
  moodOnly: boolean
  scale: number
  reasons: string[]
}

export interface ReduceEvent extends ValidatedAppraisal {
  occurredAtMs: number
}

function cloneSnapshot(snapshot: AffectSnapshot): AffectSnapshot {
  return {
    principalId: snapshot.principalId,
    revision: snapshot.revision,
    projectedThroughSeq: snapshot.projectedThroughSeq,
    asOfMs: snapshot.asOfMs,
    personality: { ...snapshot.personality },
    relationship: { ...snapshot.relationship },
    mood: { ...snapshot.mood },
    openEpisodeIds: [...snapshot.openEpisodeIds],
    ruleVersion: snapshot.ruleVersion,
  }
}

export function initialSnapshot(
  principalId: string,
  preset: keyof typeof PRESETS,
  ruleVersion: string,
  nowMs: number,
): AffectSnapshot {
  return {
    principalId,
    revision: 0,
    projectedThroughSeq: 0,
    asOfMs: nowMs,
    personality: { ...PRESETS[preset] },
    relationship: { ...INITIAL_RELATIONSHIP },
    mood: { ...INITIAL_MOOD },
    openEpisodeIds: [],
    ruleVersion,
  }
}

/**
 * 只做衰减的读取投影：用于「这一轮没有任何新事件，但需要向模型报告当前
 * 状态」。不写库、不改 revision。
 */
export function projectSnapshot(snapshot: AffectSnapshot, nowMs: number, config: AffectConfig): AffectSnapshot {
  const elapsed = nowMs - snapshot.asOfMs
  if (!Number.isFinite(elapsed) || elapsed <= 0) return cloneSnapshot(snapshot)
  const next = cloneSnapshot(snapshot)
  next.mood = decayMood(snapshot.mood, elapsed, {
    halfLifeMinutes: config.halfLifeMinutes,
    decayGrievance: false,
  })
  next.relationship = decayRelationship(snapshot.relationship, elapsed, { decayGrievance: false })
  next.asOfMs = nowMs
  return next
}

/** 冲突事件才合并 episode；其他事件各自独立，避免把道歉也塞进争吵里。 */
function isConflictKind(kind: EventKind): boolean {
  return kind === 'insult' || kind === 'boundary' || kind === 'teasing'
}

export function reduce(
  previous: AffectSnapshot,
  event: ReduceEvent,
  clock: Clock,
  config: AffectConfig,
  context: ReduceContext,
): ReduceResult {
  const explanations: ExplanationCode[] = []
  const state = cloneSnapshot(previous)
  const nowMs = clock.now()
  const effectiveMs = Number.isFinite(event.occurredAtMs) ? Math.min(event.occurredAtMs, nowMs) : nowMs

  if (context.seenIdempotencyKeys.has(context.idempotencyKey)) {
    return {
      next: state,
      explanations: ['skip:duplicate'],
      episode: {
        id: 'none',
        kind: event.kind,
        status: 'open',
        lastEventAtMs: effectiveMs,
        uniqueMessageCount: 1,
        appliedDeltas: { affection: 0, trust: 0, respect: 0, grievance: 0 },
        isNew: false,
        deltaToApply: { affection: 0, trust: 0, respect: 0, grievance: 0 },
      },
      moodOnly: false,
      scale: 0,
      reasons: ['duplicate'],
    }
  }

  // 1) 先在事件时刻做一次分量衰减（不是每分钟 tick）。
  const elapsed = effectiveMs - state.asOfMs
  if (elapsed > 0) {
    state.mood = decayMood(state.mood, elapsed, {
      halfLifeMinutes: config.halfLifeMinutes,
      decayGrievance: false,
    })
    state.relationship = decayRelationship(state.relationship, elapsed, { decayGrievance: false })
    state.asOfMs = effectiveMs
  }

  // 2) 归类门槛。
  const eligibility = checkEligibility(
    {
      appraisal: {
        kind: event.kind,
        intent: event.intent,
        target: event.target,
        severity: event.severity,
        confidence: event.confidence,
        source: event.source,
      },
      fromInboundUserMessage: context.fromInboundUserMessage,
      establishedTeasingContext: context.establishedTeasingContext,
      roleplay: context.roleplay,
    },
    config,
  )

  const effect = scaleEffect(event, state.personality, state.relationship, config)
  const reasons = [...effect.reasons]

  if (!eligibility.eligible) {
    explanations.push(`skip:${eligibility.reason.replace(/_/g, '-')}` as ExplanationCode)
    if (!eligibility.softMoodOnly) {
      return {
        next: state,
        explanations,
        episode: {
          ...(context.episode ?? {
            id: 'none',
            kind: event.kind,
            status: 'open',
            lastEventAtMs: effectiveMs,
            uniqueMessageCount: 1,
            appliedDeltas: { affection: 0, trust: 0, respect: 0, grievance: 0 },
          }),
          isNew: false,
          deltaToApply: { affection: 0, trust: 0, respect: 0, grievance: 0 },
        },
        moodOnly: false,
        scale: effect.scale,
        reasons,
      }
    }
    // 低置信/互损语境：只允许当下轻微不快，不形成长期恶意结论。
    const softFactor = 0.35
    state.mood = {
      anger: clamp(state.mood.anger + Math.max(0, effect.mood.anger) * softFactor),
      hurt: clamp(state.mood.hurt + Math.max(0, effect.mood.hurt) * softFactor),
      joy: clamp(state.mood.joy + effect.mood.joy * softFactor),
      tension: clamp(state.mood.tension + Math.max(0, effect.mood.tension) * softFactor),
      expressiveness: clamp(state.mood.expressiveness + effect.mood.expressiveness * softFactor),
    }
    explanations.push('mood-only:soft')
    state.revision = previous.revision + 1
    state.projectedThroughSeq = previous.projectedThroughSeq + 1
    state.asOfMs = nowMs
    return {
      next: state,
      explanations,
      episode: {
        ...(context.episode ?? {
          id: 'none',
          kind: event.kind,
          status: 'open',
          lastEventAtMs: effectiveMs,
          uniqueMessageCount: 0,
          appliedDeltas: { affection: 0, trust: 0, respect: 0, grievance: 0 },
        }),
        isNew: false,
        deltaToApply: { affection: 0, trust: 0, respect: 0, grievance: 0 },
      },
      moodOnly: true,
      scale: effect.scale,
      reasons: [...reasons, 'softMoodOnly'],
    }
  }

  // 3) 心情增量：受控、有界。
  state.mood = {
    anger: clamp(state.mood.anger + effect.mood.anger),
    hurt: clamp(state.mood.hurt + effect.mood.hurt),
    joy: clamp(state.mood.joy + effect.mood.joy),
    tension: clamp(state.mood.tension + effect.mood.tension),
    expressiveness: clamp(state.mood.expressiveness + effect.mood.expressiveness),
  }

  // 4) 关系增量：合并同段争执时只应用差额。
  const mergeable =
    context.episode !== undefined &&
    isConflictKind(event.kind) &&
    isSameConflictEpisode(
      context.episode.lastEventAtMs,
      effectiveMs,
      event.kind,
      event.target as Target,
      config.conflictEpisodeGapMinutes,
    )

  const uniqueCount = mergeable ? context.episode!.uniqueMessageCount + 1 : 1
  const multiplier = mergeable ? repeatMultiplier(uniqueCount) : 1
  const desired: RelationshipDelta = {
    affection: effect.relationship.affection * multiplier,
    trust: effect.relationship.trust * multiplier,
    respect: effect.relationship.respect * multiplier,
    grievance: effect.relationship.grievance * multiplier,
  }
  const alreadyApplied: RelationshipDelta = mergeable
    ? context.episode!.appliedDeltas
    : { affection: 0, trust: 0, respect: 0, grievance: 0 }
  const rawDelta: RelationshipDelta = {
    affection: desired.affection - alreadyApplied.affection,
    trust: desired.trust - alreadyApplied.trust,
    respect: desired.respect - alreadyApplied.respect,
    grievance: desired.grievance - alreadyApplied.grievance,
  }

  const capped = applyDailyCaps(rawDelta, context.dailyUsed, config.dailyAbsoluteDeltaCaps)
  if (capped.clipped.length > 0) {
    explanations.push('cap:daily')
    reasons.push(`dailyCap:${capped.clipped.join(',')}`)
  }
  const applied = capped.applied

  state.relationship = {
    affection: config.allowNegativeRelationship
      ? round3(clamp(state.relationship.affection + applied.affection, -1, 1))
      : round3(clamp(state.relationship.affection + applied.affection, 0, 1)),
    trust: round3(clamp(state.relationship.trust + applied.trust, 0, 1)),
    respect: round3(clamp(state.relationship.respect + applied.respect, 0, 1)),
    grievance: round3(clamp(state.relationship.grievance + applied.grievance, 0, 1)),
    familiarity: round3(clamp(state.relationship.familiarity + 0.002 * effect.scale, 0, 1)),
  }
  if (
    state.relationship.affection === (config.allowNegativeRelationship ? -1 : 0) ||
    state.relationship.trust === 0 ||
    state.relationship.trust === 1
  ) {
    explanations.push('clamp:range')
  }

  // 5) episode 状态推进。
  let episode = context.episode
  let isNew = false
  if (episode !== undefined && mergeable) {
    episode = { ...episode, lastEventAtMs: effectiveMs, uniqueMessageCount: uniqueCount }
    explanations.push('episode:merged')
  } else if (isConflictKind(event.kind) && event.target === 'self') {
    episode = {
      id: `ep_${event.sourceMessageId}_${effectiveMs}`,
      kind: event.kind,
      status: 'open',
      lastEventAtMs: effectiveMs,
      uniqueMessageCount: 1,
      appliedDeltas: { affection: 0, trust: 0, respect: 0, grievance: 0 },
    }
    isNew = true
    explanations.push('episode:opened')
  } else if (episode !== undefined && isRepairIntent(event.intent, event.kind)) {
    episode = { ...episode, status: 'repairing', lastEventAtMs: effectiveMs }
    explanations.push('episode:repairing')
  }

  const cumulative: RelationshipDelta = {
    affection: alreadyApplied.affection + applied.affection,
    trust: alreadyApplied.trust + applied.trust,
    respect: alreadyApplied.respect + applied.respect,
    grievance: alreadyApplied.grievance + applied.grievance,
  }

  state.revision = previous.revision + 1
  state.projectedThroughSeq = previous.projectedThroughSeq + 1
  state.asOfMs = nowMs
  if (episode !== undefined && !state.openEpisodeIds.includes(episode.id) && episode.status !== 'archived') {
    state.openEpisodeIds = [...state.openEpisodeIds, episode.id].slice(-8)
  }

  return {
    next: state,
    explanations: explanations.length === 0 ? ['ok'] : explanations,
    episode: {
      ...(episode ?? {
        id: 'none',
        kind: event.kind,
        status: 'open',
        lastEventAtMs: effectiveMs,
        uniqueMessageCount: 1,
        appliedDeltas: cumulative,
      }),
      isNew,
      deltaToApply: applied,
    },
    moodOnly: false,
    scale: effect.scale,
    reasons,
  }
}

export interface StateSummary {
  relationshipLevels: string
  moodLevels: string
  episodeHint: string
  rules: string
}

/**
 * 把状态压成给人看的等级（§11.3 动态状态模板）。只用等级不用数值，
 * 阈值滞后避免四舍五入导致每轮跳变。
 */
export function summarizeState(snapshot: AffectSnapshot, previousSummary?: StateSummary): StateSummary {
  const relationshipParts: string[] = []
  const affection = pickLevel(snapshot.relationship.affection, AFFECTION_LEVELS, previousLabelOf(previousSummary?.relationshipLevels, AFFECTION_LEVELS))
  const trust = pickLevel(snapshot.relationship.trust, TRUST_LEVELS, previousLabelOf(previousSummary?.relationshipLevels, TRUST_LEVELS))
  if (affection !== undefined) relationshipParts.push(affection)
  if (trust !== undefined) relationshipParts.push(trust)
  if (snapshot.relationship.grievance >= 0.3) relationshipParts.push('心里还存着事')

  const moodParts: string[] = []
  const anger = pickLevel(snapshot.mood.anger, ANGER_LEVELS, previousLabelOf(previousSummary?.moodLevels, ANGER_LEVELS))
  const hurt = pickLevel(snapshot.mood.hurt, HURT_LEVELS, previousLabelOf(previousSummary?.moodLevels, HURT_LEVELS))
  const tension = pickLevel(snapshot.mood.tension, TENSION_LEVELS, previousLabelOf(previousSummary?.moodLevels, TENSION_LEVELS))
  if (anger !== undefined) moodParts.push(anger)
  if (hurt !== undefined) moodParts.push(hurt)
  if (tension !== undefined) moodParts.push(tension)
  if (moodParts.length === 0) moodParts.push('心情平稳')

  return {
    relationshipLevels: relationshipParts.length > 0 ? relationshipParts.join('、') : '还不太熟',
    moodLevels: moodParts.join('、'),
    episodeHint: snapshot.openEpisodeIds.length > 0 ? `有 ${snapshot.openEpisodeIds.length} 件未了结的事` : '没有悬着的事',
    rules: '',
  }
}

function previousLabelOf(summary: string | undefined, levels: readonly { label: string }[]): string | undefined {
  if (summary === undefined) return undefined
  for (const level of levels) if (summary.includes(level.label)) return level.label
  return undefined
}
