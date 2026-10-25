import test from 'node:test'
import assert from 'node:assert/strict'
import { composePersonality, TEMPLATES } from '../../lib/domain/personality-profile.js'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { projectExpression } from '../../lib/domain/expression-plan.js'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { PersonalityProfiles } from '../../lib/storage/personality-profiles.js'

const options = { mix: { gentle: .45, earnest: .35, playful: .2 }, overrides: { reserve: .65 }, variation: { enabled: true, maxDelta: .05, seed: 'stable' } }
test('A01 / A02: mixed personality is deterministic, respects overrides and rejects invalid input', () => {
  const input = { companionId: 'c', personaId: 'p', nowMs: 1, options }
  assert.deepEqual(composePersonality(input), composePersonality(input))
  assert.equal(composePersonality(input).traits.reserve, .65)
  assert.equal(Object.keys(TEMPLATES).length, 8)
  for (const mix of [{ gentle: 0 }, { gentle: -1 }, { unknown: 1 }, { gentle: NaN }]) assert.throws(() => composePersonality({ ...input, options: { ...options, mix } }))
})
test('A06: repeated real contact can ease expression without awarding trust or mutating personality', () => {
  const state = initialSnapshot('p', 'gentle', 'v1', 1)
  const before = structuredClone(state)
  const initial = projectExpression({ state, userText: '你好', nowMs: 1, contactExposure: { messages: 1, days: 1 } })
  const familiar = projectExpression({ state, userText: '你好', nowMs: 1, contactExposure: { messages: 500, days: 60 } })
  assert.ok(familiar.ease > initial.ease)
  assert.deepEqual(state, before)
  assert.equal(state.relationship.trust, .5)
})
test('A03 / A04: profile persists through binding/restart without changing relationships or crossing roles', () => {
  const f = fixture({ config: { personality: options } })
  try {
    const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
    const a = owner.binding('dsh', 's', 'device', f.now(), { id: 'one', preset: 'balanced' })
    const before = f.repos.getSnapshot(a.principalId).snapshot
    const b = owner.binding('dsh', 's', 'device', f.now(), { id: 'two', preset: 'balanced' })
    assert.notEqual(a.principalId, b.principalId)
    owner.binding('dsh', 's', 'device', f.now() + 10, { id: 'one', preset: 'balanced' })
    assert.deepEqual(f.repos.getSnapshot(a.principalId).snapshot, before)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM personality_heads').n, 2)
  } finally { f.close() }
})
test('personality commands adjust individual traits and reject invalid updates atomically', () => {
  const f = fixture()
  try {
    assert.equal(f.command('personality mix gentle=.6 earnest=.4').kind, 'success')
    const profiles = new PersonalityProfiles(f.repos)
    const before = profiles.get(f.config.companion.id, 'builtin')
    assert.equal(f.command('personality set reserve=.8').kind, 'success')
    const after = profiles.get(f.config.companion.id, 'builtin')
    assert.equal(after.traits.reserve, .8)
    assert.equal(after.traits.warmth, before.traits.warmth)
    assert.deepEqual(after.templates, before.templates)
    assert.equal(f.command('personality set unknown=.5').kind, 'error')
    assert.equal(profiles.get(f.config.companion.id, 'builtin').revisionId, after.revisionId)
  } finally { f.close() }
})
