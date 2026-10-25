import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { initialSnapshot, projectSnapshot } from '../../lib/domain/affect-reducer.js'
import { expressionProfile, renderExpressionStyle } from '../../lib/domain/expression-style.js'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { estimateTokens } from '../../lib/runtime/context-budget.js'
import { interactionHabits } from '../../lib/memory/interaction-habits.js'

test('expression follows closeness, joy, anger and hurt without changing personality or forcing slang', () => {
  const state = initialSnapshot('p', 'gentle', 'test', 0)
  const stranger = expressionProfile(state)
  assert.match(renderExpressionStyle(state), /还不熟/)
  state.relationship = { affection: 0.8, trust: 0.9, respect: 0.8, familiarity: 0.9, grievance: 0 }
  state.mood.joy = 0.6
  const before = structuredClone(state)
  const close = expressionProfile(state)
  assert.ok(close.ease > stranger.ease)
  assert.ok(close.openness > stranger.openness)
  assert.equal(close.tone, 'bright')
  assert.equal(close.playful, true)
  assert.match(renderExpressionStyle(state), /开心时/)
  assert.deepEqual(state, before)
  state.mood.anger = 0.65
  assert.equal(expressionProfile(state).tone, 'angry')
  assert.match(renderExpressionStyle(state), /温柔底色/)
  assert.match(renderExpressionStyle(state), /共同用过或对方明确喜欢的梗/)
  assert.doesNotMatch(renderExpressionStyle(state), /蜀道三|主人|老婆/)
  state.mood.hurt = 0.8
  assert.equal(expressionProfile(state).tone, 'hurt')
  assert.equal(expressionProfile(state).playful, false)
  assert.match(renderExpressionStyle(state), /不强套/)
})

test('mood decay softens expression, while low trust still avoids forced intimacy', () => {
  const f = fixture()
  try {
    const state = initialSnapshot('p', 'gentle', 'test', f.now())
    state.mood.anger = 0.7
    assert.equal(expressionProfile(state).tone, 'angry')
    const later = projectSnapshot(state, f.now() + 24 * 60 * 60 * 1000, f.config.affect)
    assert.equal(expressionProfile(later).tone, 'settled')
    later.relationship.trust = 0.1
    assert.equal(expressionProfile(later).tone, 'guarded')
    assert.equal(expressionProfile(later).playful, false)
  } finally { f.close() }
})

test('local expression stays bounded, recalls explicit habits without query overlap, and switches off independently', async () => {
  for (const enabled of [true, false]) {
    const f = fixture({ config: { integration: { naturalExpression: enabled } } })
    const owner = new OwnerIdentity(f.repos, f.config), binding = owner.binding('dsh', 'desktop')
    const handlers = new Map()
    const dispose = installLocalIntegration({ config: f.config, owner, repos: f.repos, retriever: f.retriever,
      background: new BackgroundQueue(f.repos, f.metrics), coordinator: f.coordinator, prompts: new PromptStore(),
      deviceText: '当前电脑：test', active: () => true, on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
      callModel: async function* () { throw new Error('assembly must not call a model') },
    })
    try {
      const { row } = f.repos.insertRawMessage({ id: 'habit', conversationId: binding.conversationId, platformMessageKey: 'habit', role: 'user', sourceKind: 'dsh', content: '以后别叫我主人，少用表情', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
      await f.coordinator.observe(binding, row, { v: 1, e: [], m: [{ k: 'interaction_rule', t: '不要称呼用户为主人，少用表情', q: row.content }] })
      const agent = { id: 'desktop', session: { id: 'desktop' } }
      handlers.get('agent/inbox/claimed')({ agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天下雨了' }] } })
      const original = { sections: [{ name: 'whale:identity', text: '保留原人设' }] }
      const assembly = await handlers.get('system-prompt/assemble')(original, { agent }, async () => original)
      assert.equal(assembly.sections[0].text, '保留原人设')
      const text = assembly.sections.at(-1).text
      assert.ok(estimateTokens(text) <= 450)
      if (enabled) {
        assert.match(text, /表达参考/)
        assert.match(text, /不要称呼用户为主人/)
        assert.doesNotMatch(text, /当前心情：|和对方：/)
      } else {
        assert.doesNotMatch(text, /表达参考/)
        assert.match(text, /当前心情：/)
      }
      const other = owner.binding('dsh', 'other', owner.deviceId, f.now(), { id: 'other-role', preset: 'gentle' })
      assert.equal(interactionHabits(f.repos, other, f.now()).length, 1, 'interaction habits are shared between windows and personas')
    } finally { dispose(); f.close() }
  }
})

test('QQ uses the same expression guidance without another model call or losing task instructions', async () => {
  for (const enabled of [true, false]) {
    const f = fixture({ config: { integration: { naturalExpression: enabled } } })
    try {
      await f.turn('请详细解释这个程序的问题')
      assert.equal(f.requests.length, 1)
      if (enabled) {
        assert.match(f.requests[0].systemText, /表达参考/)
        assert.match(f.requests[0].systemText, /正事及明确的详细说明要求优先/)
      } else assert.doesNotMatch(f.requests[0].systemText, /表达参考/)
    } finally { f.close() }
  }
})
