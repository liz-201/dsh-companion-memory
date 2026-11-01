import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseIntimacyIntent, renderIntimacyDirection, INTIMACY_GUIDANCE, INTIMACY_THRESHOLDS } from '../../lib/expression/intimacy-policy.js'
import { projectExpression } from '../../lib/domain/expression-plan.js'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { renderPlan } from '../../lib/expression/policy.js'
import { regulateExpression } from '../../lib/expression/regulation.js'
import { estimateTokens } from '../../lib/runtime/context-budget.js'

const now = 1793503500000
const state = (value = .3, extra = {}) => ({ version: 'erotic-interest-v1', atMs: now, value,
  evidenceIds: ['source-a'], blocked: false, blockReason: null, parameterVersion: 'erotic-engineering-v1', ...extra })
const input = (extra = {}) => ({ state: state(), mode: 'chat', isPrivate: true,
  invitation: { sourceId: 'source-a', atMs: now, eligible: true }, nowMs: now, ...extra })
const plan = (value = .3, text = '想更亲近一些') => {
  const p = projectExpression({ state: initialSnapshot('owner', 'gentle', 'test', now), userText: text, nowMs: now })
  p.continuous = { version: 'continuous-v1', parameterVersion: 'test',
    drives: { atMs: now, contact: 0, exploration: 0, load: 0, responses: 0 },
    pad: { emotion: { pleasure: 0, arousal: 0, dominance: 0 }, mood: { pleasure: 0, arousal: 0, dominance: 0 }, controlKnown: false },
    emotions: [], displays: [], evidenceIds: [], appraisalCount: 1,
    relationship: { atMs: now, intimacy: .15, desire: 0, passion: 0, evidenceIds: [], sourceCount: 0, parameterVersion: 'test' },
    eroticInterest: state(value) }
  p.intimacyIntent = chooseIntimacyIntent(input({ state: p.continuous.eroticInterest, mode: p.mode }))
  return p
}

test('a current eligible private chat has a nonzero flutter and yearning output channel', () => {
  const flutter = chooseIntimacyIntent(input())
  const yearning = chooseIntimacyIntent(input({ state: state(.8) }))
  assert.equal(flutter.kind, 'flutter')
  assert.equal(yearning.kind, 'yearning')
  assert.equal(flutter.sourceId, 'source-a')
  assert.deepEqual(flutter.reasonCodes, ['intimacy:flutter'])
  assert.equal(renderIntimacyDirection(flutter, state(.3), 'chat'), INTIMACY_GUIDANCE.flutter)
  assert.equal(renderIntimacyDirection(yearning, state(.8), 'chat'), INTIMACY_GUIDANCE.yearning)
})

test('disabled, adult-unknown, stopped and absent evidence cannot create a direction', () => {
  for (const reason of ['disabled', 'adult-context-unknown', 'owner-stop']) {
    const value = reason === 'owner-stop' ? 0 : null
    assert.equal(chooseIntimacyIntent(input({ state: state(value, { blocked: true, blockReason: reason }) })).kind, 'none')
  }
  assert.equal(chooseIntimacyIntent(input({ state: null })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ state: state(null) })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ state: state(0) })).kind, 'none')
})

test('the threshold epsilon does not erase real decay, and all range edges are explicit', () => {
  for (const value of [.25 - 2e-12, 0, .1]) assert.equal(chooseIntimacyIntent(input({ state: state(value) })).kind, 'none')
  for (const value of [.25, .25 - 5e-13, .3, .5 - 2e-12]) assert.equal(chooseIntimacyIntent(input({ state: state(value) })).kind, 'flutter')
  for (const value of [.5, .5 - 5e-13, .8, 1]) assert.equal(chooseIntimacyIntent(input({ state: state(value) })).kind, 'yearning')
  const afterTenMinutes = .3 * 2 ** (-10 / 720)
  assert.ok(afterTenMinutes > .25 && afterTenMinutes < .3)
  assert.equal(chooseIntimacyIntent(input({ state: state(afterTenMinutes) })).kind, 'flutter')
  for (const value of [NaN, Infinity, -Infinity, -.1, 1.01]) assert.equal(chooseIntimacyIntent(input({ state: state(value) })).kind, 'none')
})

test('invitation expiry uses its original time with cutoff minus one, equal and plus one millisecond', () => {
  const ttl = INTIMACY_THRESHOLDS.invitationTtlMs
  for (const age of [ttl - 1, ttl]) {
    const value = input({ invitation: { sourceId: 'source-a', atMs: now - age, eligible: true } })
    assert.equal(chooseIntimacyIntent(value).kind, 'flutter')
  }
  assert.equal(chooseIntimacyIntent(input({ invitation: { sourceId: 'source-a', atMs: now - ttl - 1, eligible: true } })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ invitation: { sourceId: 'source-a', atMs: now + 1, eligible: true } })).kind, 'none')
})

test('global delivery cooldown uses cutoff minus one, equal and plus one millisecond', () => {
  const gap = INTIMACY_THRESHOLDS.expressionGapMs
  assert.equal(chooseIntimacyIntent(input({ lastExpressionAtMs: now - gap + 1 })).kind, 'none')
  for (const age of [gap, gap + 1]) assert.equal(chooseIntimacyIntent(input({ lastExpressionAtMs: now - age })).kind, 'flutter')
  assert.equal(chooseIntimacyIntent(input({ lastExpressionAtMs: now + 1 })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ lastExpressionAtMs: NaN })).kind, 'none')
})

test('a used invitation never supplies a second expression, and an expired invite is not delayed until cooldown ends', () => {
  assert.equal(chooseIntimacyIntent(input({ lastExpressionSourceId: 'source-a', lastExpressionAtMs: now - 30 * 60000 })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ lastExpressionSourceId: 'source-old', lastExpressionAtMs: now - 20 * 60000 })).kind, 'flutter')
  assert.equal(chooseIntimacyIntent(input({ invitation: { sourceId: 'source-old', atMs: now - 20 * 60000, eligible: true }, lastExpressionAtMs: now - 20 * 60000 })).kind, 'none')
})

test('structured, task, support and creative modes, nonprivate surfaces and proactive output are suppressed', () => {
  for (const mode of ['structured', 'task', 'support', 'creative']) assert.equal(chooseIntimacyIntent(input({ mode, state: state(1) })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ isPrivate: false })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ proactive: true })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ invitation: { sourceId: 'source-a', atMs: now, eligible: false } })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ invitation: null })).kind, 'none')
})

test('malformed clocks and IDs do not manufacture a source or infer permission', () => {
  for (const sourceId of ['', ' ', 'x\n', 'x'.repeat(501)]) {
    assert.equal(chooseIntimacyIntent(input({ invitation: { sourceId, atMs: now, eligible: true } })).kind, 'none')
  }
  assert.equal(chooseIntimacyIntent(input({ nowMs: NaN })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ state: state(.3, { atMs: now + 1 }) })).kind, 'none')
  assert.equal(chooseIntimacyIntent(input({ invitation: { sourceId: 'source-a', atMs: NaN, eligible: true } })).kind, 'none')
})

test('reading a plan repeatedly neither consumes its invitation nor mutates the caller state', () => {
  const request = input(), before = structuredClone(request), first = chooseIntimacyIntent(request)
  for (let i = 0; i < 10000; i++) assert.deepEqual(chooseIntimacyIntent(request), first)
  assert.deepEqual(request, before)
  const next = chooseIntimacyIntent(request)
  assert.notEqual(next.reasonCodes, first.reasonCodes)
})

test('rendering prioritizes only one compatible intimacy clause while keeping the 150 token budget', () => {
  for (const value of [.3, .8]) {
    const p = plan(value)
    p.continuous.experiences = [{ kind: 'tenderness', intensity: .9 }, { kind: 'longing', intensity: .8 }]
    const text = renderPlan(p), guidance = INTIMACY_GUIDANCE[p.intimacyIntent.kind]
    assert.ok(text.includes(guidance))
    assert.ok(estimateTokens(text) <= 150)
    assert.equal(text.includes('牵挂绑定真实的人或事'), false)
    assert.equal(text.includes('对具体关心自然柔和'), false)
    assert.equal(text.includes('不声称真实生理需要'), value >= .5)
  }
})

test('an eligible intimacy direction does not compete with the neutral instruction to show no emotion', () => {
  const p = plan(.3)
  p.stance = 'neutral'
  assert.ok(renderPlan(p).includes(INTIMACY_GUIDANCE.flutter))
  assert.equal(renderPlan(p).includes('不表演情绪'), false)
  p.intimacyIntent = {kind:'none',reasonCodes:['intimacy:unknown']}
  assert.equal(renderPlan(p).includes('不表演情绪'), true)
})

test('regulation and rendering reject a stale or forged positive intent in blocked and nonchat plans', () => {
  for (const mode of ['structured', 'task', 'support', 'creative']) {
    const p = plan(.8)
    p.mode = mode
    const before = structuredClone(p), result = regulateExpression(p)
    assert.equal(result.intimacyIntent.kind, 'none')
    assert.ok(result.reasonCodes.includes('regulate:intimacy-suppressed'))
    assert.deepEqual(p, before)
    assert.equal(renderPlan(p).includes(INTIMACY_GUIDANCE.yearning), false)
    assert.equal(renderPlan(result).includes(INTIMACY_GUIDANCE.yearning), false)
  }
  for (const change of [{ value: null }, { value: .1 }, { value: 0, blocked: true, blockReason: 'owner-stop' }]) {
    const p = plan(.8)
    Object.assign(p.continuous.eroticInterest, change)
    assert.equal(regulateExpression(p).intimacyIntent.kind, 'none')
    assert.equal(renderPlan(p).includes(INTIMACY_GUIDANCE.yearning), false)
  }
})

test('erotic audit uses its own threshold and neither raises contact nor changes legacy desire or passion', () => {
  for (const value of [.6, .8, 1]) {
    const p = plan(value), before = structuredClone(p)
    const result = regulateExpression(p)
    assert.ok(result.reasonCodes.includes('regulate:no-consent-inference'))
    assert.ok(result.reasonCodes.includes('regulate:intimacy-evidence-not-consent'))
    assert.deepEqual(result.targetSentences, before.targetSentences)
    assert.deepEqual(result.continuous.relationship, before.continuous.relationship)
    assert.deepEqual(result.continuous.drives, before.continuous.drives)
    assert.deepEqual(p, before)
  }
  assert.equal(regulateExpression(plan(.6 - 2e-12)).reasonCodes.includes('regulate:intimacy-evidence-not-consent'), false)
})
