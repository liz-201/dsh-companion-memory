import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRESETS,
  initialSnapshot,
  projectSnapshot,
  reduce,
  summarizeState,
} from '../../lib/domain/affect-reducer.js'
import { emptyDelta } from '../../lib/domain/episode-manager.js'
import { fixedClock } from '../../lib/domain/types.js'
import { resolveConfig } from '../../lib/config.js'

const config = resolveConfig()
const affect = config.affect
const T0 = 1_760_000_000_000 // 2025-10-09T08:53:20Z
const clock = fixedClock(T0)
const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)

function makeContext(over = {}) {
  return {
    dailyUsed: emptyDelta(),
    fromInboundUserMessage: true,
    establishedTeasingContext: false,
    roleplay: false,
    idempotencyKey: 'idem-1',
    seenIdempotencyKeys: new Set(),
    ...over,
  }
}

function appraisal(over = {}) {
  return {
    sourceMessageId: 'msg-1',
    kind: 'insult',
    intent: 'hostile',
    target: 'self',
    severity: 2,
    confidence: 0.9,
    source: 'live_tail',
    revision: 1,
    occurredAtMs: T0,
    ...over,
  }
}

test('T01 骂报错不扣关系：target=problem 直接跳过', () => {
  const result = reduce(base, appraisal({ target: 'problem', intent: 'hostile' }), clock, affect, makeContext())
  assert.ok(result.explanations.includes('skip:target-not-self'), result.explanations.join(','))
  assert.deepEqual(result.next.relationship, base.relationship)
})

test('骂本人且敌意高置信 → 关系下降、怒气上升', () => {
  const result = reduce(base, appraisal(), clock, affect, makeContext())
  assert.ok(!result.explanations.some((code) => code.startsWith('skip:')), result.explanations.join(','))
  assert.ok(result.next.relationship.trust < base.relationship.trust, '信任应下降')
  assert.ok(result.next.mood.anger > base.mood.anger, '怒气应上升')
  assert.ok(result.moodOnly === false)
})

test('敌意置信度低于门槛 → skip:low-hostile-confidence', () => {
  const result = reduce(
    base,
    appraisal({ confidence: Math.max(0, affect.hostileConfidenceThreshold - 0.3) }),
    clock,
    affect,
    makeContext(),
  )
  assert.ok(result.explanations.includes('skip:low-hostile-confidence'), result.explanations.join(','))
  assert.deepEqual(result.next.relationship, base.relationship)
})

test('幂等键重复 → skip:duplicate，状态不变', () => {
  const result = reduce(base, appraisal(), clock, affect, makeContext({ seenIdempotencyKeys: new Set(['idem-1']) }))
  assert.ok(result.explanations.includes('skip:duplicate'), result.explanations.join(','))
  assert.equal(result.next.revision, base.revision)
})

test('角色扮演范围内不扣关系 → skip:roleplay-scope', () => {
  const result = reduce(base, appraisal(), clock, affect, makeContext({ roleplay: true }))
  assert.ok(result.explanations.includes('skip:roleplay-scope'), result.explanations.join(','))
})

test('非入站用户消息（如系统事件）不改变关系', () => {
  const result = reduce(base, appraisal(), clock, affect, makeContext({ fromInboundUserMessage: false }))
  assert.ok(result.explanations.includes('skip:not-inbound-user-message'), result.explanations.join(','))
})

test('道歉接在未结 episode 上 → episode:repairing 且信任回升', () => {
  const hurt = reduce(base, appraisal({ severity: 3 }), clock, affect, makeContext())
  const episode = {
    id: hurt.episode.id,
    kind: 'insult',
    status: 'open',
    lastEventAtMs: T0,
    uniqueMessageCount: 2,
    appliedDeltas: hurt.episode.deltaToApply,
  }
  const repaired = reduce(
    hurt.next,
    appraisal({ kind: 'apology', intent: 'repair', severity: 2, idempotencyKey: 'idem-2', occurredAtMs: T0 + 60_000 }),
    clock,
    affect,
    makeContext({ idempotencyKey: 'idem-2', episode }),
  )
  assert.ok(repaired.explanations.includes('episode:repairing'), repaired.explanations.join(','))
  assert.ok(repaired.next.relationship.trust >= hurt.next.relationship.trust, '道歉不应继续降低信任')
})

test('当天额度用尽 → cap:daily，关系只做衰减不叠加负向', () => {
  const used = emptyDelta()
  used.trust = -1
  used.affection = -1
  used.respect = -1
  used.grievance = 1
  const result = reduce(base, appraisal(), clock, affect, makeContext({ dailyUsed: used }))
  assert.ok(result.explanations.includes('cap:daily'), result.explanations.join(','))
  assert.ok(result.next.relationship.trust >= projectSnapshot(base, T0, affect).relationship.trust - 1e-9)
})

test('已建立互损语境下的玩笑 → skip:established-teasing，不写关系', () => {
  const result = reduce(
    base,
    appraisal({ kind: 'teasing', intent: 'playful', target: 'self', severity: 1, confidence: 0.8 }),
    clock,
    affect,
    makeContext({ establishedTeasingContext: true }),
  )
  assert.ok(result.explanations.includes('skip:established-teasing'), result.explanations.join(','))
  assert.deepEqual(result.next.relationship, projectSnapshot(base, T0, affect).relationship)
})

test('敌意置信不足 → 只影响当下心情（mood-only:soft）', () => {
  const result = reduce(
    base,
    appraisal({ kind: 'insult', intent: 'hostile', confidence: Math.max(0, affect.hostileConfidenceThreshold - 0.3) }),
    clock,
    affect,
    makeContext(),
  )
  assert.equal(result.moodOnly, true, result.explanations.join(','))
  assert.deepEqual(result.next.relationship, projectSnapshot(base, T0, affect).relationship)
})

test('衰减投影：长时间无事件后怒气回落、grievance 半衰', () => {
  const angry = reduce(base, appraisal({ severity: 3 }), clock, affect, makeContext()).next
  const later = projectSnapshot(angry, T0 + 24 * 60 * 60_000, affect)
  assert.ok(later.mood.anger < angry.mood.anger, '24 小时后怒气应低于峰值')
  assert.ok(later.relationship.grievance <= angry.relationship.grievance)
})

test('状态摘要只用等级词，不泄漏原始数值', () => {
  const summary = summarizeState(base)
  assert.equal(typeof summary.relationshipLevels, 'string')
  assert.ok(!/\d\.\d{2}/.test(summary.relationshipLevels + summary.moodLevels), '摘要不应出现小数数值')
})

test('三套人格预设的激进度单调递增', () => {
  assert.ok(PRESETS.irritable.irritability > PRESETS.balanced.irritability)
  assert.ok(PRESETS.balanced.irritability > PRESETS.gentle.irritability)
})
