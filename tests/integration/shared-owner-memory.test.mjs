import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fixture, appreciation, insult } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { initialSnapshot, PRESETS } from '../../lib/domain/affect-reducer.js'
import { unifyOwnerState } from '../../lib/storage/shared-owner.js'
import { exportPortable, readPortable, importPortable } from '../../lib/storage/portable.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'

function legacy(f, owner, role, address = role) {
  const suffix = createHash('sha256').update(role).digest('hex').slice(0, 24)
  const principalId = owner.principalId + ':persona:' + suffix
  const conversationId = 'old-conversation-' + role
  f.repos.ensurePrincipal(principalId, f.config.companion.id, 'owner', owner.ownerId + ':persona:' + suffix, f.now())
  f.repos.ensureConversation(conversationId, principalId, 'private', `dsh:device:persona:${suffix}:${address}`, f.now())
  f.db.run('INSERT INTO owner_channels VALUES (?, ?, ?, ?)', conversationId, 'dsh', 'device', address)
  f.repos.setSetting('persona.id:' + principalId, role, f.now())
  f.repos.putSnapshot(initialSnapshot(principalId, 'balanced', f.config.affect.ruleVersion, f.now()), 0)
  return { ...f.binding, botAccountId: 'device', userId: owner.ownerId, principalId, conversationId }
}
const command = (f, binding, raw) => handleFishCommand({ binding, raw, isOwner: true, nowMs: f.now() }, { config: f.config, repos: f.repos, db: f.db, updater: f.updater, retriever: f.retriever, metrics: f.metrics })

test('different windows, models and editable host personas share one emotional state, personality, memory and habit source', async t => {
  const f = fixture({ events: [appreciation, insult] })
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  const a = owner.binding('dsh', 'one', 'device', f.now(), { id: 'prompt:one', preset: 'gentle' })
  const b = owner.binding('dsh', 'two', 'device', f.now(), { id: 'preset:other-model', preset: 'irritable' })
  assert.equal(a.principalId, b.principalId)
  assert.notEqual(a.conversationId, b.conversationId)
  await f.turn('你做得很好', { binding: a })
  const affection = f.repos.getSnapshot(a.principalId).snapshot.relationship.affection
  assert.ok(affection > .15)
  assert.equal(f.repos.getSnapshot(b.principalId).snapshot.relationship.affection, affection)
  assert.equal(command(f, a, 'remember 我喜欢蓝色').kind, 'success')
  assert.match(command(f, b, 'memory 蓝色').text, /我喜欢蓝色/)
  await f.turn('你是笨蛋', { binding: b })
  assert.equal(f.repos.activeAffectEvents(a.principalId).length, 2)
  assert.equal(command(f, b, 'personality set playfulness=.9 warmth=.85').kind, 'success')
  const before = f.repos.getSnapshot(a.principalId).snapshot
  const changed = owner.binding('dsh', 'one', 'device', f.now(), { id: 'prompt:edited-again', preset: 'irritable' })
  assert.equal(changed.principalId, a.principalId)
  assert.equal(changed.conversationId, a.conversationId)
  assert.deepEqual(f.repos.getSnapshot(changed.principalId).snapshot, before)
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM affect_snapshots WHERE principal_id = ?', owner.principalId).n, 1)
})

test('legacy partitions merge with a recovery backup, all source IDs and memories preserved, and one replayed emotional history', async t => {
  const f = fixture({ events: [appreciation, insult] })
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  const a = legacy(f, owner, 'old-a'), b = legacy(f, owner, 'old-b')
  await f.turn('你真棒', { binding: a })
  f.advance(60000)
  await f.turn('你是笨蛋', { binding: b })
  command(f, a, 'remember 我住在杭州')
  command(f, b, 'remember 我喜欢咖啡')
  f.repos.setSetting(`proactive.model-interests:${a.principalId}`, '["天文"]', f.now())
  f.repos.setSetting(`proactive.model-interests:${b.principalId}`, '["音乐"]', f.now())
  f.repos.setSetting(`proactive.snooze-until:${b.principalId}`, String(f.now() + 600000), f.now())
  const raw = f.db.all('SELECT id, content, conversation_id FROM raw_messages ORDER BY id')
  const memories = f.db.all('SELECT id, claim FROM memories ORDER BY id')
  const events = f.db.all('SELECT id FROM affect_events ORDER BY id')
  assert.equal(unifyOwnerState(f.repos, f.config, owner.ownerId, f.now()), 2)
  assert.deepEqual(f.db.all('SELECT id, content, conversation_id FROM raw_messages ORDER BY id'), raw)
  assert.deepEqual(f.db.all('SELECT id, claim FROM memories ORDER BY id'), memories)
  assert.deepEqual(f.db.all('SELECT id FROM affect_events ORDER BY id'), events)
  assert.equal(f.db.get('SELECT COUNT(DISTINCT principal_id) AS n FROM memories').n, 1)
  assert.equal(f.repos.activeAffectEvents(owner.principalId).length, 2)
  assert.ok(f.repos.getSnapshot(owner.principalId).snapshot.relationship.affection < .4, 'initial affection is not added once per partition')
  assert.equal(f.repos.getSnapshot(a.principalId), undefined)
  assert.equal(f.repos.getSetting(`identity.shared-alias:${a.principalId}`), owner.principalId)
  assert.equal(f.repos.getSetting(`proactive.snooze-until:${owner.principalId}`), String(f.now() + 600000))
  assert.deepEqual(new Set(JSON.parse(f.repos.getSetting(`proactive.model-interests:${owner.principalId}`))), new Set(['天文', '音乐']))
  const report = JSON.parse(f.repos.getSetting('local.shared-owner.report'))
  assert.ok(existsSync(report.backup))
  const backup = new DatabaseSync(report.backup, { readOnly: true })
  try { assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM affect_snapshots').get().n, 2) } finally { backup.close() }
  assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
  const snapshot = f.repos.getSnapshot(owner.principalId)
  assert.equal(unifyOwnerState(f.repos, f.config, owner.ownerId, f.now()), 0)
  new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  assert.deepEqual(f.repos.getSnapshot(owner.principalId), snapshot)
  assert.equal(owner.binding('dsh', 'old-a', 'device', f.now()).conversationId, a.conversationId, 'existing channel keeps its reminder destination')
})

test('importing an old partitioned snapshot normalizes it atomically and importing it again does not duplicate history', async t => {
  const a = fixture({ events: [appreciation] }), b = fixture()
  t.after(() => { a.close(); b.close() })
  const owner = new OwnerIdentity(a.repos, a.config, a.now(), 'device')
  const old = legacy(a, owner, 'legacy')
  await a.turn('你真棒', { binding: old })
  command(a, old, 'remember 我喜欢下雨天')
  const file = join(a.directory, 'legacy.companion.json')
  exportPortable(a.db, a.config, file, { includePlugin: false })
  const { payload, checksum } = readPortable(file)
  importPortable(b.db, b.config, payload, checksum)
  const restored = new OwnerIdentity(b.repos, b.config, b.now(), 'new-device')
  const binding = restored.binding('dsh', 'different-window', 'new-device', b.now(), { id: 'another-character', preset: 'irritable' })
  assert.equal(binding.principalId, owner.principalId)
  assert.equal(b.repos.getSnapshot(old.principalId), undefined)
  assert.match(command(b, binding, 'memory 下雨').text, /我喜欢下雨天/)
  assert.equal(b.repos.activeAffectEvents(binding.principalId).length, 1)
  const before = b.repos.counts()
  assert.equal(importPortable(b.db, b.config, payload, checksum).alreadyImported, true)
  assert.deepEqual(b.repos.counts(), before)
  assert.deepEqual(b.db.all('PRAGMA foreign_key_check'), [])
})

test('a failed migration rolls back all changes and retains the old data plus recovery backup', t => {
  const f = fixture()
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  const a = legacy(f, owner, 'broken')
  f.repos.appendAffectEvent({ id: 'bad-event', principalId: a.principalId, conversationId: a.conversationId, appraisalId: null, episodeId: null, idempotencyKey: 'bad-event', eventTimeMs: f.now(), payload: {}, ruleVersion: f.config.affect.ruleVersion, status: 'active', createdAtMs: f.now() })
  f.db.run('UPDATE affect_events SET payload_json = ? WHERE id = ?', '{invalid-json', 'bad-event')
  const before = f.repos.counts()
  assert.throws(() => unifyOwnerState(f.repos, f.config, owner.ownerId, f.now()))
  assert.deepEqual(f.repos.counts(), before)
  assert.ok(f.repos.getSnapshot(a.principalId))
  assert.equal(f.repos.getSetting(`identity.shared-alias:${a.principalId}`), undefined)
})

test('a baseline newer than joined historical events is rebased before replay, so already accumulated state is not counted twice', async t => {
  const f = fixture({ events: [appreciation] })
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  const old = legacy(f, owner, 'before-reset')
  await f.turn('你真棒', { binding: old })
  const baseline = initialSnapshot(owner.principalId, 'balanced', f.config.affect.ruleVersion, f.now() + 3600000)
  baseline.relationship.affection = .9
  f.repos.setSetting(`affect.baseline:${owner.principalId}`, JSON.stringify(baseline), f.now())
  unifyOwnerState(f.repos, f.config, owner.ownerId, f.now() + 3600001)
  assert.ok(f.repos.getSnapshot(owner.principalId).snapshot.relationship.affection < .4)
  assert.equal(JSON.parse(f.repos.getSetting('local.shared-owner.report')).rebased, true)
})

test('a snapshot with no event history is retained instead of reset, and another owner is never silently folded in', t => {
  const f = fixture()
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  const old = legacy(f, owner, 'snapshot-only')
  const state = f.repos.getSnapshot(old.principalId)
  state.snapshot.relationship.affection = .82
  f.repos.putSnapshot({ ...state.snapshot, revision: state.revision + 1 }, state.revision)
  const otherId = `${f.config.companion.id}:owner:another-person:persona:role`
  f.repos.ensurePrincipal(otherId, f.config.companion.id, 'owner', 'another-person:persona:role', f.now())
  f.repos.putSnapshot(initialSnapshot(otherId, 'balanced', f.config.affect.ruleVersion, f.now()), 0)
  unifyOwnerState(f.repos, f.config, owner.ownerId, f.now())
  assert.equal(f.repos.getSnapshot(owner.principalId).snapshot.relationship.affection, .82)
  assert.ok(f.repos.getSnapshot(otherId))
  assert.equal(f.repos.getSetting(`identity.shared-alias:${otherId}`), undefined)
})

test('an unanswered message blocks the shared owner in every window, and a reply in another window clears that pause', t => {
  const f = fixture()
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'device')
  const a = owner.binding('dsh', 'a', 'device', f.now()), b = owner.binding('dsh', 'b', 'device', f.now())
  f.repos.enqueueOutbox({ id: 'idle-message', conversationId: a.conversationId, turnId: null, candidateKey: 'idle-message', taskId: null, content: '聊一句', contentHash: 'h', plannedAtMs: f.now(), expectedInboundSeq: null })
  f.repos.finishOutbox('idle-message', { kind: 'accepted', atMs: f.now() })
  assert.equal(f.repos.unresolvedOutbox(b.conversationId, 0).length, 1)
  f.repos.insertRawMessage({ id: 'reply-in-b', conversationId: b.conversationId, platformMessageKey: 'reply-in-b', role: 'user', sourceKind: 'dsh', content: '我看到了', occurredAtMs: f.now() + 1, observedAtMs: f.now() + 1, deliveryStatus: null, deletedAtMs: null })
  assert.equal(f.repos.unresolvedOutbox(a.conversationId, 0).length, 0)
})
