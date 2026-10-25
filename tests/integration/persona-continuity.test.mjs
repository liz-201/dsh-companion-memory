import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture, appreciation } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { PersonaContexts } from '../../lib/runtime/persona-context.js'
import { PRESETS, initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { resolveConfig } from '../../lib/config.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { exportPortable, readPortable, importPortable } from '../../lib/storage/portable.js'

test('balanced default upgrades implicit irritability without erasing relationship or explicit selections', () => {
  assert.equal(resolveConfig().companion.preset, 'balanced')
  const f = fixture()
  try {
    const owner = new OwnerIdentity(f.repos, f.config)
    const old = initialSnapshot(owner.principalId, 'irritable', f.config.affect.ruleVersion, f.now())
    old.relationship.trust = 0.83
    old.mood.hurt = 0.12
    f.repos.putSnapshot(old, 0)
    owner.binding('dsh', 'one')
    const current = f.repos.getSnapshot(owner.principalId).snapshot
    assert.deepEqual(current.personality, PRESETS.balanced)
    assert.deepEqual(current.relationship, old.relationship)
    assert.deepEqual(current.mood, old.mood)
    f.repos.setSetting('companion.preset', 'irritable', f.now())
    owner.binding('dsh', 'one')
    assert.deepEqual(f.repos.getSnapshot(owner.principalId).snapshot.personality, PRESETS.irritable)
  } finally { f.close() }
})

test('host preset changes and copied devices use one shared memory, queued observations and personality', async () => {
  const f = fixture({ config: { integration: { personaPresets: { 'preset:whale': 'gentle' } } } }), other = fixture()
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'A')
  const personas = new PersonaContexts(f.repos, f.config)
  const session = { id: 'desktop', header: { agentPreset: 'whale' }, snapshotEvents: () => events }
  const events = [], agent = { id: 'main', session }, listeners = new Map()
  const background = new BackgroundQueue(f.repos, f.metrics)
  const dispose = installLocalIntegration({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    config: f.config, owner, personas, repos: f.repos, retriever: f.retriever, background, coordinator: f.coordinator,
    prompts: new PromptStore(), deviceText: '电脑 A', active: () => true,
    callModel: async function* () { yield { text: `<evt>${JSON.stringify({ v: 1, e: [appreciation], m: [{ k: 'preference', t: '喜欢蓝色', q: '喜欢蓝色' }] })}</evt>` } },
  })
  const binding = () => owner.binding('dsh', session.id, 'A', f.now(), personas.resolve(agent))
  const command = (binding, raw) => handleFishCommand({ binding, raw, isOwner: true, nowMs: f.now() }, { config: f.config, repos: f.repos, db: f.db, retriever: f.retriever, updater: f.updater, metrics: f.metrics })
  try {
    const whale = binding()
    assert.deepEqual(f.repos.getSnapshot(whale.principalId).snapshot.personality, PRESETS.balanced)
    const message = { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢你，我喜欢蓝色' }] }
    listeners.get('session/event')(session, { type: 'user/message', seq: 1, time: f.now(), surfaceOp: 'append', data: message })
    events.push({ type: 'agent-preset/selected', data: { agentPreset: 'fish' } })
    const fish = binding()
    assert.equal(fish.principalId, whale.principalId)
    assert.equal(fish.conversationId, whale.conversationId)
    await background.tick(Date.now() + 10000)
    assert.equal(f.repos.activeAffectEvents(whale.principalId).length, 1)
    assert.equal(f.repos.activeAffectEvents(fish.principalId).length, 1)
    assert.match(command(whale, 'memory 蓝色').text, /喜欢蓝色/)
    assert.match(command(fish, 'memory 蓝色').text, /喜欢蓝色/)
    assert.equal(command(whale, 'personality irritable').kind, 'success')
    assert.deepEqual(f.repos.getSnapshot(fish.principalId).snapshot.personality, PRESETS.irritable)
    events.push({ type: 'agent-preset/selected', data: { agentPreset: 'whale' } })
    assert.equal(binding().principalId, whale.principalId)
    assert.deepEqual(f.repos.getSnapshot(whale.principalId).snapshot.personality, PRESETS.irritable)
    const file = join(f.directory, 'roles.companion.json')
    exportPortable(f.db, f.config, file, { includePlugin: false })
    const transfer = readPortable(file)
    importPortable(other.db, other.config, transfer.payload, transfer.checksum)
    const imported = new OwnerIdentity(other.repos, other.config, other.now(), 'B')
    const restored = imported.binding('dsh', 'new-session', 'B', other.now(), { id: 'preset:whale', preset: 'gentle' })
    assert.equal(restored.principalId, whale.principalId)
    assert.deepEqual(other.repos.getSnapshot(restored.principalId).snapshot, f.repos.getSnapshot(whale.principalId).snapshot)
    events.push({ type: 'agent-preset/selected', data: { agentPreset: null } })
    assert.equal(personas.resolve(agent).id, 'builtin', 'clearing selection must not retain the previous preset')
  } finally { dispose(); f.close(); other.close() }
})

test('persona text fallback ignores model and working-directory changes; explicit identity keeps editable characters stable', () => {
  const f = fixture()
  try {
    const roles = new PersonaContexts(f.repos, f.config)
    const agent = { session: { id: 's' } }
    const sections = text => [{ name: 'whale:persona', text }, { name: 'deployment:persona-suffix', text: 'CWD is D:/x' }]
    const a = roles.resolve(agent, sections('温柔的鲸鱼娘'))
    assert.equal(roles.resolve(agent).id, a.id)
    assert.equal(roles.resolve(agent, [...sections('温柔的鲸鱼娘'), { name: 'model', text: 'new-model' }]).id, a.id)
    assert.notEqual(roles.resolve(agent, sections('另一角色')).id, a.id)
    assert.equal(roles.resolve(agent, sections('温柔的鲸鱼娘')).id, a.id)
    const fixed = new PersonaContexts(f.repos, resolveConfig({ integration: { personaId: 'my-whale', personaPresets: { 'my-whale': 'gentle' } } }))
    assert.deepEqual(fixed.resolve(agent, sections('修改后的设定')), { id: 'my-whale', preset: 'gentle' })
    assert.throws(() => resolveConfig({ integration: { personaPresets: { whale: 'typo' } } }), /personaPresets/)
  } finally { f.close() }
})
