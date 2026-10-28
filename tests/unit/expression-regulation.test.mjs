import test from 'node:test'
import assert from 'node:assert/strict'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { projectExpression } from '../../lib/domain/expression-plan.js'
import { regulateExpression, REGULATION_THRESHOLDS } from '../../lib/expression/regulation.js'

const now = 1792814400000
const planFor = (text, continuous) => {
  const plan = projectExpression({ state: initialSnapshot('p', 'gentle', 'v1', now), userText: text, nowMs: now })
  if (continuous) plan.continuous = continuous
  return plan
}
const affect = (over = {}) => ({
  version: 'continuous-v1',
  parameterVersion: 'test',
  drives: { atMs: now, contact: 0, exploration: 0, load: 0, responses: 0 },
  pad: { emotion: { pleasure: 0, arousal: 0, dominance: 0 }, mood: { pleasure: 0, arousal: 0, dominance: 0 }, controlKnown: true },
  emotions: [],
  displays: [],
  evidenceIds: [],
  appraisalCount: 0,
  ...over,
})
const added = (next, plan) => next.reasonCodes.filter(code => !plan.reasonCodes.includes(code))

test('regulation: returns a copy and never mutates the input plan', () => {
  const plan = planFor('你好', affect({ emotions: [{ category: 'anger', intensity: .9 }] }))
  const before = JSON.stringify(plan)
  const next = regulateExpression(plan)
  assert.equal(JSON.stringify(plan), before)
  assert.notEqual(next, plan)
  assert.notEqual(next.reasonCodes, plan.reasonCodes)
  assert.deepEqual(next.reasonCodes.slice(0, plan.reasonCodes.length), plan.reasonCodes)
})

test('regulation: structured is a pure pass-through', () => {
  const rich = affect({
    emotions: [{ category: 'anger', intensity: .9 }, { category: 'fear', intensity: .8 }],
    drives: { atMs: now, contact: .95, exploration: .5, load: .9, responses: 3 },
    pad: { emotion: { pleasure: -.8, arousal: .9, dominance: -.5 }, mood: { pleasure: -.7, arousal: .6, dominance: -.4 }, controlKnown: true },
  })
  const plan = planFor('只输出JSON，键为金额，值为1.25。', rich)
  const next = regulateExpression(plan)
  assert.deepEqual(next, plan)
  assert.deepEqual(added(next, plan), [])
})

test('regulation: high-arousal joy is preserved, arousal alone suppresses nothing', () => {
  const plan = planFor('你好', affect({
    emotions: [{ category: 'joy', intensity: .8 }],
    pad: { emotion: { pleasure: .7, arousal: .95, dominance: .4 }, mood: { pleasure: .6, arousal: .9, dominance: .3 }, controlKnown: true },
  }))
  const next = regulateExpression(plan)
  assert.equal(next.playfulness, plan.playfulness)
  assert.notEqual(next.stance, 'firm')
  assert.equal(added(next, plan).includes('regulate:joy-preserved'), true)
})

test('regulation: fear and sadness never turn into punishment', () => {
  const plan = planFor('你好', affect({ emotions: [{ category: 'fear', intensity: .9 }, { category: 'distress', intensity: .85 }] }))
  plan.stance = 'firm'
  const next = regulateExpression(plan)
  assert.notEqual(next.stance, 'firm')
  assert.equal(added(next, plan).includes('regulate:fear-not-firm'), true)
  assert.equal(added(next, plan).includes('regulate:impulse-contained'), false)
})

test('regulation: anger-family impulse contains jokes and keeps the concrete point', () => {
  const plan = planFor('帮我看看这个报错', affect({ emotions: [{ category: 'anger', intensity: .8 }, { category: 'reproach', intensity: .75 }] }))
  plan.playfulness = .8
  plan.allowedMemeIds = ['meme-a', 'meme-b']
  plan.requiredFacts = ['报错栈第一行是 TypeError']
  plan.sourceIds = ['msg-1']
  const next = regulateExpression(plan)
  assert.equal(next.playfulness, 0)
  assert.deepEqual(next.allowedMemeIds, [])
  assert.deepEqual(next.requiredFacts, plan.requiredFacts)
  assert.deepEqual(next.sourceIds, plan.sourceIds)
  assert.equal(next.stance, 'firm')
  assert.equal(added(next, plan).includes('regulate:impulse-contained'), true)
})

test('regulation: mild anger keeps the jokes and does not force a firm stance', () => {
  const plan = planFor('你好', affect({ emotions: [{ category: 'anger', intensity: .3 }] }))
  plan.playfulness = .7
  const next = regulateExpression(plan)
  assert.equal(next.playfulness, .7)
  assert.notEqual(next.stance, 'firm')
  assert.deepEqual(added(next, plan), [])
})

test('regulation: support never takes the scene and never escalates', () => {
  const plan = planFor('我现在很难过', affect({ emotions: [{ category: 'anger', intensity: .9 }] }))
  const next = regulateExpression(plan)
  assert.equal(next.stance, 'supportive')
  assert.equal(next.playfulness, 0)
  assert.deepEqual(next.allowedMemeIds, plan.allowedMemeIds)
  assert.equal(added(next, plan).includes('regulate:support-focus'), true)
})

test('regulation: high passion assumes no consent and raises no contact', () => {
  const plan = planFor('你好', affect({
    emotions: [{ category: 'love', intensity: .9 }],
    relationship: { intimacy: .9, desire: .9, passion: .95 },
  }))
  const next = regulateExpression(plan)
  assert.deepEqual(next.targetSentences, plan.targetSentences)
  assert.deepEqual(next.allowedMemeIds, plan.allowedMemeIds)
  assert.equal(added(next, plan).includes('regulate:no-consent-inference'), true)
})

test('regulation: fact text and protected spans are never rewritten', () => {
  const plan = planFor('帮我看看这个报错', affect({ emotions: [{ category: 'anger', intensity: .9 }] }))
  plan.requiredFacts = ['第 12 行返回 null']
  plan.protectedSpans = [{ kind: 'code', text: 'const x = null' }]
  const next = regulateExpression(plan)
  assert.deepEqual(next.requiredFacts, ['第 12 行返回 null'])
  assert.deepEqual(next.protectedSpans, [{ kind: 'code', text: 'const x = null' }])
})

test('regulation: deterministic and side-effect free across repeated calls', () => {
  const plan = planFor('你好', affect({ emotions: [{ category: 'anger', intensity: .9 }, { category: 'joy', intensity: .7 }] }))
  const first = regulateExpression(plan)
  const second = regulateExpression(plan)
  assert.deepEqual(first, second)
  assert.deepEqual(regulateExpression(first), first)
})

test('regulation: every added reason code is prefixed and thresholds are explicit initials', () => {
  const plan = planFor('你好', affect({
    emotions: [{ category: 'anger', intensity: .9 }, { category: 'fear', intensity: .8 }],
    relationship: { passion: .95 },
  }))
  const codes = added(regulateExpression(plan), plan)
  assert.ok(codes.length > 0)
  for (const code of codes) assert.match(code, /^regulate:/)
  for (const value of Object.values(REGULATION_THRESHOLDS)) {
    assert.equal(typeof value, 'number')
    assert.ok(value > 0 && value < 1, `${value} is not a usable initial threshold`)
  }
})
