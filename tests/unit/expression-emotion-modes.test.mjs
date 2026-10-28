import test from 'node:test'
import assert from 'node:assert/strict'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { projectExpression } from '../../lib/domain/expression-plan.js'
import { taskMode } from '../../lib/expression/task-mode.js'
import { renderPlan, SUPPORT_ANCHOR } from '../../lib/expression/policy.js'
import { estimateTokens } from '../../lib/runtime/context-budget.js'

const now = 1792814400000
const DISPLAYS = ['委屈', '心酸', '愧疚', '吃味', '被重视感', '安心', '失落']
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

test('task mode: verbatim and format contracts outrank emotional content', () => {
  assert.equal(taskMode('只输出JSON，键为金额，值为1.25。'), 'structured')
  assert.equal(taskMode('逐字复述：不是明天，是周五。'), 'structured')
  assert.equal(taskMode('我现在很难过，只输出JSON'), 'structured')
})

test('task mode: the owner speaking about their own distress outranks the technical task', () => {
  assert.equal(taskMode('我很难过，你帮我看看这个报错'), 'support')
  assert.equal(taskMode('我现在有点委屈'), 'support')
  assert.equal(taskMode('这个函数返回 0，我有点难受'), 'support')
  assert.equal(taskMode('帮我看看这个报错'), 'task')
})

test('task mode: quoted or discussed emotion words never swallow the task', () => {
  assert.equal(taskMode('帮我分析这段代码里的难过'), 'task')
  assert.notEqual(taskMode('分类器把“难过”判成了 support，帮我查一下'), 'support')
  assert.equal(taskMode('这段正则为什么匹配不到委屈，帮我排查一下'), 'task')
  assert.notEqual(taskMode('这段正则为什么匹配不到委屈'), 'support')
})

test('task mode: negation and third-party reports stay chat', () => {
  assert.equal(taskMode('我不难过，就是有点累'), 'chat')
  assert.equal(taskMode('他今天挺失落的'), 'chat')
  assert.equal(taskMode('你好'), 'chat')
})

test('expression: chat keeps the evidence-bound guidance for the first two displays', () => {
  const text = renderPlan(planFor('今天过得怎么样', affect({ displays: ['被重视感', '安心'], pad: { emotion: { pleasure: .5, arousal: 0, dominance: 0 }, mood: { pleasure: .4, arousal: 0, dominance: 0 }, controlKnown: true } })))
  assert.match(text, /记得的具体小事/)
  assert.doesNotMatch(text, /gratitude|0\.9|PAD/)
})

test('expression: support opens with the owner difficulty and never turns into self-pity', () => {
  const bare = renderPlan(planFor('我现在很难过'))
  assert.equal(bare.includes(SUPPORT_ANCHOR), true)
  const text = renderPlan(planFor('我现在很难过', affect({ displays: ['委屈', '心酸'], drives: { atMs: now, contact: .9, exploration: 0, load: 0, responses: 0 } })))
  assert.equal(text.includes(SUPPORT_ANCHOR), true)
  assert.doesNotMatch(text, /牵挂感|查岗/)
  assert.equal(text.split('。').filter(Boolean).length <= 6, true)
})

test('expression: task keeps a measurable tone residue without any emotion word', () => {
  const low = renderPlan(planFor('帮我看看这个报错', affect({ drives: { atMs: now, contact: .1, exploration: 0, load: 0, responses: 0 } })))
  const high = renderPlan(planFor('帮我看看这个报错', affect({ drives: { atMs: now, contact: .9, exploration: 0, load: 0, responses: 0 }, displays: ['委屈', '心酸'] })))
  assert.notEqual(low, high)
  for (const word of DISPLAYS) {
    assert.equal(low.includes(word), false, `low residue leaked ${word}`)
    assert.equal(high.includes(word), false, `high residue leaked ${word}`)
  }
})

test('expression: creative only overlays positive tone and never negative evidence', () => {
  const negative = renderPlan(planFor('写一篇短文', affect({ displays: ['委屈', '心酸'], pad: { emotion: { pleasure: -.6, arousal: .2, dominance: -.2 }, mood: { pleasure: -.5, arousal: 0, dominance: 0 }, controlKnown: true } })))
  assert.equal(negative, renderPlan(planFor('写一篇短文')))
  const positive = renderPlan(planFor('写一篇短文', affect({ displays: ['安心'], pad: { emotion: { pleasure: .4, arousal: 0, dominance: 0 }, mood: { pleasure: .3, arousal: 0, dominance: 0 }, controlKnown: true } })))
  assert.match(positive, /略轻快/)
})

test('expression: structured injects no continuous affect or drive direction at all', () => {
  const rich = affect({ displays: ['委屈', '心酸', '愧疚', '吃味', '被重视感', '安心', '失落'], drives: { atMs: now, contact: .95, exploration: .5, load: .9, responses: 3 }, pad: { emotion: { pleasure: -.8, arousal: .8, dominance: -.5 }, mood: { pleasure: -.7, arousal: .6, dominance: -.4 }, controlKnown: true } })
  assert.equal(renderPlan(planFor('只输出JSON', rich)), renderPlan(planFor('只输出JSON')))
})

test('expression: 失落 now has its own guidance line instead of occupying a slot silently', () => {
  const text = renderPlan(planFor('你好', affect({ displays: ['失落'] })))
  assert.match(text, /没成的具体期待/)
})

test('expression: every mode stays inside the 150 token budget with a rich state', () => {
  const rich = affect({ displays: ['委屈', '心酸', '愧疚', '吃味', '被重视感', '安心', '失落'], drives: { atMs: now, contact: .95, exploration: .5, load: .9, responses: 3 }, pad: { emotion: { pleasure: -.8, arousal: .8, dominance: -.5 }, mood: { pleasure: -.7, arousal: .6, dominance: -.4 }, controlKnown: true } })
  for (const text of ['你好', '我现在很难过', '帮我看看这个报错', '写一篇短文', '只输出JSON']) {
    const plan = planFor(text, rich)
    assert.ok(estimateTokens(renderPlan(plan)) <= 150, `${plan.mode} exceeded budget`)
  }
})
