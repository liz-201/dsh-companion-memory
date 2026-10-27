import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { Consolidator, memoryIdFor } from '../../lib/memory/consolidator.js'
import { reuseOwnerMemoryId } from '../../lib/memory/identity-memory.js'
import { deleteScope } from '../../lib/storage/deletion.js'
import { exportPortable, readPortable } from '../../lib/storage/portable.js'
import { previewOwnerMerge, confirmOwnerMerge } from '../../lib/storage/owner-merge.js'

const hintText = '用户喜欢冰美式'
const hintModel = async function* () {
  yield { text: '<say>收到</say>' }
  yield { text: `<evt>${JSON.stringify({ v: 1, e: [], m: [{ k: 'preference', t: hintText, q: '我喜欢冰美式' }] })}</evt>` }
}

function device(t, label, options = {}) {
  const f = fixture(options)
  t.after(() => f.close())
  f.db.run('DELETE FROM conversations WHERE id=?', f.binding.conversationId)
  f.db.run('DELETE FROM principals WHERE id=?', f.binding.principalId)
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), label)
  const binding = owner.binding('dsh', `window-${label}`, label, f.now())
  return { ...f, owner, binding, consolidator: new Consolidator(f.repos, f.config.background, f.updater) }
}

function source(f, id, content = '我住在杭州') {
  return f.repos.insertRawMessage({ id, conversationId: f.binding.conversationId, platformMessageKey: id,
    role: 'user', sourceKind: 'dsh', content, occurredAtMs: f.now(), observedAtMs: f.now(),
    deliveryStatus: null, deletedAtMs: null }).row
}

function fact(messageId) {
  return { kind: 'fact', subject: '用户', predicate: '居住城市', object: '杭州', claim: '用户住在杭州',
    sourceMessageIds: [messageId], quote: '住在杭州', confidence: .95, salience: .7, eventAtMs: null }
}

function apply(f, message) {
  return f.consolidator.applyPlan({ conversationId: message.conversationId, principalId: f.owner.principalId,
    messages: [{ id: message.id, role: message.role, content: message.content, occurredAtMs: message.occurredAtMs, seq: message.seq }],
    cursor: message.seq, estimatedTokens: 10, dropped: 0 }, { changes: [fact(message.id)] }, f.now())
}

function pair(local, remote, name = 'identity-merge.companion.json') {
  source(remote, `remote-${name}`)
  const file = join(remote.directory, name)
  exportPortable(remote.db, remote.config, file, { includePlugin: false, nowMs: remote.now() })
  const { payload, checksum } = readPortable(file)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  confirmOwnerMerge(local.db, local.config, payload, checksum, preview)
  assert.equal(local.owner.ownerId, remote.owner.ownerId)
}

const memories = f => f.db.all('SELECT * FROM memories WHERE principal_id=? ORDER BY id', f.owner.principalId)

function insertMemory(f, id, principalId) {
  f.repos.insertMemory({ id, principalId, conversationId: null, visibility: 'private', kind: 'fact', subjectKey: '用户',
    predicateKey: '职业', object: '工程师', claim: '用户是工程师', sourceKind: 'consolidation', confidence: .9,
    salience: .5, validFromMs: null, validToMs: null, eventAtMs: null, observedAtMs: f.now(), activationAtMs: f.now(),
    evidence: [], lexicalTerms: '工程师', aliases: '' })
}

test('paired Consolidator reuses the migrated fact ID for both the same and new source messages', t => {
  const local = device(t, 'fact-local'), remote = device(t, 'fact-remote')
  const message = source(local, 'fact-source')
  apply(local, message)
  const oldId = memoryIdFor(local.owner.principalId, fact(message.id))
  pair(local, remote)
  assert.notEqual(oldId, memoryIdFor(local.owner.principalId, fact(message.id)))
  assert.equal(apply(local, message).rejected.length, 0)
  assert.equal(apply(local, source(local, 'fact-source-new')).rejected.length, 0)
  assert.deepEqual(memories(local).map(row => row.id), [oldId])
  assert.equal(local.repos.memoryEvidence(oldId).length, 2)
  assert.equal(local.db.get('SELECT COUNT(*) AS n FROM memory_edges').n, 0)
})

test('a legacy bare memoryId tombstone still rejects re-extraction after pairing', t => {
  const local = device(t, 'bare-local'), remote = device(t, 'bare-remote')
  const message = source(local, 'bare-source')
  apply(local, message)
  const oldId = memories(local)[0].id
  local.repos.insertTombstone({ id: 'bare-delete', principalId: local.owner.principalId,
    selector: { kind: 'memory', memoryId: oldId }, affectedIds: [oldId], createdAtMs: local.now() })
  local.repos.removeFromIndex(oldId)
  local.db.run('DELETE FROM memories WHERE id=?', oldId)
  pair(local, remote)
  const result = apply(local, message)
  assert.equal(result.applied, 0)
  assert.match(result.rejected[0].reason, /已遗忘/u)
  assert.equal(memories(local).length, 0)
})

test('modern deletion suppression continues to protect the same source after pairing', t => {
  const local = device(t, 'modern-local'), remote = device(t, 'modern-remote')
  const message = source(local, 'modern-source')
  apply(local, message)
  const oldId = memories(local)[0].id
  deleteScope(local.db, local.repos, local.owner.principalId, { kind: 'memory', memoryId: oldId }, local.now(), 30, local.config)
  pair(local, remote)
  assert.match(apply(local, message).rejected[0].reason, /已遗忘/u)
  assert.equal(memories(local).length, 0)
})

test('transitive A-to-B-to-C aliases preserve the original ID and cycles remain bounded', t => {
  const local = device(t, 'chain-a'), second = device(t, 'chain-b'), third = device(t, 'chain-c')
  const message = source(local, 'chain-source')
  apply(local, message)
  const originalPrincipal = local.owner.principalId, oldId = memories(local)[0].id
  pair(local, second, 'chain-b.companion.json')
  const middlePrincipal = local.owner.principalId
  pair(local, third, 'chain-c.companion.json')
  assert.equal(local.repos.getSetting(`identity.shared-alias:${originalPrincipal}`), middlePrincipal)
  assert.equal(local.repos.getSetting(`identity.shared-alias:${middlePrincipal}`), local.owner.principalId)
  apply(local, source(local, 'chain-source-new'))
  assert.deepEqual(memories(local).map(row => row.id), [oldId])
  local.repos.setSetting(`identity.shared-alias:${local.owner.principalId}`, originalPrincipal, local.now())
  let calls = 0
  assert.equal(reuseOwnerMemoryId(local.repos, local.owner.principalId, principal => { calls++; return memoryIdFor(principal, fact(message.id)) }), oldId)
  assert.ok(calls <= 256)
})

test('canonical live IDs take precedence but another owner memory is never reused', t => {
  const f = device(t, 'owner-isolation')
  const current = f.owner.principalId, previous = `${current}:old`, other = 'unrelated-owner'
  f.repos.setSetting(`identity.shared-alias:${previous}`, current, f.now())
  f.repos.ensurePrincipal(other, f.config.companion.id, 'owner', other, f.now())
  const derive = principal => `test-memory:${principal}`
  insertMemory(f, derive(previous), current)
  insertMemory(f, derive(current), current)
  assert.equal(reuseOwnerMemoryId(f.repos, current, derive), derive(current))
  f.db.run('DELETE FROM memories WHERE id=?', derive(current))
  f.db.run('UPDATE memories SET principal_id=? WHERE id=?', other, derive(previous))
  assert.equal(reuseOwnerMemoryId(f.repos, current, derive), derive(current))
  insertMemory(f, derive(current), other)
  assert.throws(() => reuseOwnerMemoryId(f.repos, current, derive), /其他主人/u)
  assert.deepEqual(f.repos.memoryEvidence(derive(previous)), [])
})

test('an old bare tombstone takes precedence over an existing canonical memory', t => {
  const f = device(t, 'tombstone-priority'), current = f.owner.principalId, previous = `${current}:old`
  const derive = principal => `test-memory:${principal}`
  f.repos.setSetting(`identity.shared-alias:${previous}`, current, f.now())
  insertMemory(f, derive(current), current)
  f.repos.insertTombstone({ id: 'priority-delete', principalId: current,
    selector: { kind: 'memory', memoryId: derive(previous) }, affectedIds: [derive(previous)], createdAtMs: f.now() })
  assert.equal(reuseOwnerMemoryId(f.repos, current, derive), derive(previous))
})

test('Coordinator memory hints reuse the migrated ID after pairing and append only new evidence', async t => {
  const local = device(t, 'hint-local', { callModel: hintModel }), remote = device(t, 'hint-remote')
  await local.turn('我喜欢冰美式', { binding: local.binding })
  const oldId = memories(local)[0].id
  pair(local, remote)
  const binding = { ...local.binding, principalId: local.owner.principalId, userId: local.owner.ownerId }
  await local.turn('我喜欢冰美式', { binding })
  assert.deepEqual(memories(local).map(row => row.id), [oldId])
  assert.equal(local.repos.memoryEvidence(oldId).length, 2)
})

test('Coordinator memory hints cannot resurrect a bare-deleted migrated ID', async t => {
  const local = device(t, 'hint-delete-local', { callModel: hintModel }), remote = device(t, 'hint-delete-remote')
  await local.turn('我喜欢冰美式', { binding: local.binding })
  const oldId = memories(local)[0].id
  local.repos.insertTombstone({ id: 'hint-bare-delete', principalId: local.owner.principalId,
    selector: { kind: 'memory', memoryId: oldId }, affectedIds: [oldId], createdAtMs: local.now() })
  local.repos.removeFromIndex(oldId)
  local.db.run('DELETE FROM memories WHERE id=?', oldId)
  pair(local, remote)
  await local.turn('我喜欢冰美式', { binding: { ...local.binding, principalId: local.owner.principalId, userId: local.owner.ownerId } })
  assert.equal(memories(local).length, 0)
})

test('equal JSON string and null objects do not become contradictions when IDs differ', t => {
  const f = device(t, 'json-equality'), message = source(f, 'json-source')
  apply(f, message)
  const candidate = { id: 'different-id-same-object', principalId: f.owner.principalId, conversationId: f.binding.conversationId,
    visibility: 'private', kind: 'fact', subject: '用户', predicate: '居住城市', object: '杭州', claim: '用户住在杭州',
    sourceKind: 'consolidation', confidence: .9, salience: .5, eventAtMs: null, observedAtMs: f.now(),
    evidence: [{ messageId: message.id, quote: '住在杭州' }] }
  assert.equal(f.updater.write(candidate).type, 'inserted')
  assert.equal(f.updater.write({ ...candidate, id: 'null-object-one', predicate: '缺省字段', object: null }).type, 'inserted')
  assert.equal(f.updater.write({ ...candidate, id: 'null-object-two', predicate: '缺省字段', object: null }).type, 'inserted')
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM memory_edges WHERE relation='contradicts'").n, 0)
  assert.equal(memories(f).length, 4, 'This compatibility change does not add broad semantic merging')
})
