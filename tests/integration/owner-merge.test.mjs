import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fixture, appreciation, insult } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { DesktopDelivery } from '../../lib/adapters/desktop-delivery.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'
import { deleteScope, replayTombstones } from '../../lib/storage/deletion.js'
import { Database } from '../../lib/storage/database.js'
import { exportPortable, importPortable, readPortable, stableJson } from '../../lib/storage/portable.js'
import { previewOwnerMerge, confirmOwnerMerge } from '../../lib/storage/owner-merge.js'

function device(t, label, event = appreciation) {
  const f = fixture({ events: [event] })
  t.after(() => f.close())
  // These tests use real owner bindings; the generic fixture's p/c identity is unrelated.
  f.db.run('DELETE FROM conversations WHERE id = ?', f.binding.conversationId)
  f.db.run('DELETE FROM principals WHERE id = ?', f.binding.principalId)
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), label)
  const binding = owner.binding('dsh', `window-${label}`, label, f.now())
  return { ...f, owner, binding, label }
}

function remember(f, claim) {
  const before = new Set(f.db.all('SELECT id FROM memories').map(row => row.id))
  const result = handleFishCommand({ binding: f.binding, raw: `remember ${claim}`, isOwner: true, nowMs: f.now() }, {
    config: f.config, db: f.db, repos: f.repos, updater: f.updater, retriever: f.retriever, metrics: f.metrics,
  })
  assert.equal(result.kind, 'success')
  const row = f.db.all('SELECT * FROM memories').find(item => !before.has(item.id))
  assert.ok(row, 'The owner command must create a real memory record')
  assert.equal(row.principal_id, f.owner.principalId)
  return { ...row }
}

async function populated(t, label, event = appreciation) {
  const f = device(t, label, event)
  await f.turn(`来自电脑 ${label} 的重要对话。`, { binding: f.binding })
  const memory = remember(f, `用户在电脑 ${label} 上留下的重要记忆。`)
  assert.ok(f.repos.activeAffectEvents(f.owner.principalId).length > 0)
  return { ...f, memory }
}

function pack(f, name = 'owner-merge.companion.json') {
  const file = join(f.directory, name)
  exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
  return readPortable(file)
}

function databaseState(db) {
  return Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(({ name }) => [name,
    db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`).map(row => stableJson(row)).sort(),
  ]))
}

function backups(f) {
  const directory = join(f.directory, 'backups')
  return existsSync(directory) ? readdirSync(directory).sort().map(name => join(directory, name)) : []
}

const counts = f => ({
  messages: f.db.get('SELECT COUNT(*) AS n FROM raw_messages').n,
  memories: f.db.get('SELECT COUNT(*) AS n FROM memories').n,
  affectEvents: f.db.get('SELECT COUNT(*) AS n FROM affect_events').n,
})

function sourceRows(f) {
  return {
    messages: f.db.all('SELECT id, conversation_id, role, content, deleted_at_ms FROM raw_messages ORDER BY id'),
    memories: f.db.all('SELECT id, claim, object_json, status FROM memories ORDER BY id'),
    events: f.db.all('SELECT id, payload_json, status FROM affect_events ORDER BY id'),
  }
}

const unionRows = (a, b, field) => [...a[field], ...b[field]].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0)

test('ordinary imports still refuse two populated owners while a merge preview is fully read-only and creates no backup', async t => {
  const local = await populated(t, 'local'), remote = await populated(t, 'remote', insult)
  const { payload, checksum } = pack(remote)
  const oldOwner = local.owner.ownerId, before = databaseState(local.db), beforeBackups = backups(local)
  assert.notEqual(oldOwner, remote.owner.ownerId)
  assert.throws(() => importPortable(local.db, local.config, payload, checksum), error => error.code === 'owner-mismatch')
  assert.deepEqual(databaseState(local.db), before)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.equal(preview.version, 1)
  assert.equal(preview.localOwnerId, oldOwner)
  assert.equal(preview.remoteOwnerId, remote.owner.ownerId)
  assert.equal(preview.packageId, payload.id)
  assert.equal(preview.checksum, checksum)
  assert.ok(preview.localFingerprint)
  assert.ok(preview.payloadFingerprint)
  assert.deepEqual(preview.local, counts(local))
  assert.deepEqual(preview.remote, counts(remote))
  assert.deepEqual(preview.blockingConflicts, [])
  assert.ok(preview.report)
  assert.equal(preview.report.backup, null)
  assert.deepEqual(databaseState(local.db), before, 'Preview must roll back every table, including receipts, settings and FTS')
  assert.deepEqual(backups(local), beforeBackups)
  assert.equal(local.owner.ownerId, oldOwner)
  assert.equal(remote.owner.ownerId, payload.ownerId)
})

test('explicit confirmation keeps both nonempty histories under the remote canonical owner with an untouched recovery backup', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B', insult)
  const oldOwner = local.owner.ownerId, oldPrincipal = local.owner.principalId
  const left = sourceRows(local), right = sourceRows(remote)
  const { payload, checksum } = pack(remote)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  const result = confirmOwnerMerge(local.db, local.config, payload, checksum, preview)
  assert.equal(result.alreadyImported, false)
  assert.ok(result.backup && existsSync(result.backup))
  assert.equal(local.repos.getSetting('owner.id'), payload.ownerId)
  assert.equal(local.owner.ownerId, payload.ownerId, 'Existing identity services must observe adopted owner settings')
  assert.equal(local.owner.principalId, remote.owner.principalId)
  const merged = sourceRows(local)
  for (const field of ['messages', 'memories', 'events']) assert.deepEqual(merged[field], unionRows(left, right, field))
  assert.equal(local.db.get('SELECT COUNT(DISTINCT principal_id) AS n FROM memories').n, 1)
  assert.equal(local.db.get('SELECT COUNT(*) AS n FROM affect_snapshots').n, 1)
  assert.equal(local.db.get('SELECT principal_id FROM affect_snapshots').principal_id, remote.owner.principalId)
  assert.equal(local.repos.getSnapshot(oldPrincipal), undefined)
  assert.equal(local.repos.activeAffectEvents(remote.owner.principalId).length, 2)
  assert.deepEqual(local.db.all('PRAGMA foreign_key_check'), [])
  const backup = new DatabaseSync(result.backup, { readOnly: true })
  try {
    assert.equal(backup.prepare("SELECT value FROM plugin_settings WHERE key = 'owner.id'").get().value, oldOwner)
    assert.equal(backup.prepare('SELECT principal_id FROM memories WHERE id = ?').get(local.memory.id).principal_id, oldPrincipal)
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM raw_messages').get().n, left.messages.length)
    assert.equal(backup.prepare('SELECT id FROM memories WHERE id = ?').get(remote.memory.id), undefined)
  } finally { backup.close() }

  const beforeRepeat = databaseState(local.db), beforeBackups = backups(local)
  const repeat = confirmOwnerMerge(local.db, local.config, payload, checksum, preview)
  assert.equal(repeat.alreadyImported, true)
  assert.deepEqual(databaseState(local.db), beforeRepeat, 'Repeating confirmation must not replay affect or mutate receipts')
  assert.deepEqual(backups(local), beforeBackups)
})

test('a changed local memory invalidates an earlier owner-merge preview without replacing the owner or adding backups', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const { payload, checksum } = pack(remote)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  local.advance(1000)
  const lateMemory = remember(local, '预览以后刚刚记住的重要内容。')
  const before = databaseState(local.db), beforeBackups = backups(local)
  assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /变化|预览|stale|changed/i)
  assert.deepEqual(databaseState(local.db), before)
  assert.ok(local.repos.getMemory(lateMemory.id))
  assert.equal(local.owner.ownerId, preview.localOwnerId)
  assert.deepEqual(backups(local), beforeBackups)
})

test('an already registered desktop session follows its conversation to the adopted owner without re-registration', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const { payload, checksum } = pack(remote)
  const delivery = new DesktopDelivery(local.repos), appended = []
  const previousPrincipal = local.binding.principalId
  delivery.register({ id: 'already-open-desktop', append: (...args) => appended.push(args), snapshotEvents: () => [] }, local.binding, 'builtin')
  assert.equal(delivery.binding(local.binding.conversationId).principalId, previousPrincipal)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  confirmOwnerMerge(local.db, local.config, payload, checksum, preview)
  const current = delivery.binding(local.binding.conversationId)
  assert.equal(current.principalId, remote.owner.principalId)
  assert.equal(current.userId, payload.ownerId)
  assert.equal(current.conversationId, local.binding.conversationId)
  assert.notEqual(current.principalId, previousPrincipal)
  assert.deepEqual(delivery.list(), [{ conversationId: local.binding.conversationId, principalId: remote.owner.principalId }])
  const receipt = await delivery.send(local.binding.conversationId, '配对后的现有桌面会话仍可使用。', 'after-pairing-desktop', null)
  assert.equal(receipt.kind, 'accepted')
  assert.equal(appended.length, 1)
})

test('confirmation rejects a changed checksum or substituted package content even when a prior preview is supplied', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const { payload, checksum } = pack(remote)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  const before = databaseState(local.db), beforeBackups = backups(local)
  const changedChecksum = checksum === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64)
  assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, changedChecksum, preview))
  const substituted = structuredClone(payload)
  substituted.tables.raw_messages[0].content = '在预览之后被替换的原话。'
  assert.throws(() => confirmOwnerMerge(local.db, local.config, substituted, checksum, preview))
  assert.deepEqual(databaseState(local.db), before)
  assert.deepEqual(backups(local), beforeBackups)
})

test('the same message ID with different original text blocks pairing and leaves both copies recoverable', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  for (const f of [local, remote]) f.repos.insertRawMessage({
    id: 'same-id-important-message', conversationId: f.binding.conversationId, platformMessageKey: `collision-${f.label}`,
    role: 'user', sourceKind: 'dsh', content: `这段原话只属于电脑 ${f.label}。`,
    occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null,
  })
  const { payload, checksum } = pack(remote)
  const before = databaseState(local.db), otherBefore = databaseState(remote.db), beforeBackups = backups(local)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.ok(preview.blockingConflicts.some(item => item.table === 'raw_messages' && item.id === 'same-id-important-message'))
  assert.equal(preview.report, null)
  assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /冲突|conflict/i)
  assert.deepEqual(databaseState(local.db), before)
  assert.deepEqual(databaseState(remote.db), otherBefore)
  assert.deepEqual(backups(local), beforeBackups)
  assert.match(local.repos.getRawMessage('same-id-important-message').content, /电脑 A/)
  assert.match(remote.repos.getRawMessage('same-id-important-message').content, /电脑 B/)
})

test('equal memory IDs with different claims are blocking conflicts rather than a silent choice of one device', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const original = pack(remote)
  const payload = structuredClone(original.payload)
  const previousId = remote.memory.id
  payload.tables.memories.find(row => row.id === previousId).id = local.memory.id
  for (const table of ['memory_evidence', 'memory_lifecycle']) {
    for (const row of payload.tables[table]) if (row.memory_id === previousId) row.memory_id = local.memory.id
  }
  const checksum = createHash('sha256').update(stableJson(payload)).digest('hex')
  const before = databaseState(local.db)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.ok(preview.blockingConflicts.some(item => item.table === 'memories' && item.id === local.memory.id))
  assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /冲突|conflict/i)
  assert.deepEqual(databaseState(local.db), before)
  assert.equal(local.repos.getMemory(local.memory.id).claim, local.memory.claim)
  assert.equal(remote.repos.getMemory(remote.memory.id).claim, remote.memory.claim)
})

test('different deletion scopes under the same tombstone ID block pairing before either scope can delete data', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  for (const f of [local, remote]) f.repos.insertTombstone({
    id: 'colliding-deletion-id', principalId: f.owner.principalId,
    selector: { kind: 'memory', memoryId: f.memory.id }, affectedIds: [f.memory.id], createdAtMs: f.now(),
  })
  const { payload, checksum } = pack(remote)
  const before = databaseState(local.db), beforeBackups = backups(local)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.ok(preview.blockingConflicts.some(item => item.table === 'deletion_tombstones' && item.id === 'colliding-deletion-id'))
  assert.equal(preview.report, null)
  assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /冲突|conflict/i)
  assert.deepEqual(databaseState(local.db), before)
  assert.deepEqual(backups(local), beforeBackups)
  assert.ok(local.repos.getMemory(local.memory.id))
  assert.ok(remote.repos.getMemory(remote.memory.id))
})

for (const activity of ['running-turn', 'leased-background-job', 'sending-outbox']) {
  test(`confirmation refuses ${activity} without changing data or creating a backup`, async t => {
    const local = await populated(t, 'A'), remote = await populated(t, 'B')
    const { payload, checksum } = pack(remote)
    const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
    if (activity === 'running-turn') {
      const turn = local.db.get('SELECT id FROM turns LIMIT 1')
      assert.ok(turn)
      local.db.run("UPDATE turns SET status = 'running' WHERE id = ?", turn.id)
    } else if (activity === 'leased-background-job') {
      local.repos.enqueueJob({ id: 'active-job', dedupKey: 'active-job', principalId: local.owner.principalId,
        kind: 'extract', payload: {}, availableAtMs: local.now(), createdAtMs: local.now() })
      local.db.run("UPDATE background_jobs SET status = 'leased', lease_until_ms = ? WHERE id = ?", Date.now() + 60000, 'active-job')
    } else {
      local.repos.enqueueOutbox({ id: 'active-send', conversationId: local.binding.conversationId, turnId: null,
        candidateKey: 'active-send', taskId: null, content: '正在发送', contentHash: 'fixture', plannedAtMs: local.now(), expectedInboundSeq: null })
      local.repos.claimOutbox(local.now(), 1)
      assert.equal(local.db.get('SELECT status FROM outbox WHERE id = ?', 'active-send').status, 'sending')
    }
    const before = databaseState(local.db), beforeBackups = backups(local)
    assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /等待.*(?:对话|后台|发送)|完成.*预览/)
    assert.deepEqual(databaseState(local.db), before)
    assert.deepEqual(backups(local), beforeBackups)
    assert.equal(local.owner.ownerId, preview.localOwnerId)
  })
}

test('a second connection writing after the backup invalidates confirmation inside the write transaction', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const { payload, checksum } = pack(remote)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  const other = new Database({ file: local.db.file, busyTimeoutMs: 1000 })
  const originalRun = local.db.run.bind(local.db)
  const beforeBackups = new Set(backups(local))
  let raced = false, afterExternalWrite
  local.db.run = (sql, ...args) => {
    const result = originalRun(sql, ...args)
    if (!raced && /^VACUUM INTO\b/i.test(sql.trim())) {
      raced = true
      other.run('UPDATE memories SET claim = ? WHERE id = ?', '另一连接在备份后保存的新记忆。', local.memory.id)
      afterExternalWrite = databaseState(local.db)
    }
    return result
  }
  try {
    assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /变化|重新预览/)
  } finally { local.db.run = originalRun; other.close() }
  assert.equal(raced, true)
  assert.deepEqual(databaseState(local.db), afterExternalWrite, 'The concurrent update must survive while owner adoption is rejected')
  assert.equal(local.owner.ownerId, preview.localOwnerId)
  assert.equal(local.repos.getMemory(local.memory.id).claim, '另一连接在备份后保存的新记忆。')
  const retained = backups(local).filter(file => !beforeBackups.has(file))
  assert.equal(retained.length, 1)
  const backup = new DatabaseSync(retained[0], { readOnly: true })
  try { assert.equal(backup.prepare('SELECT claim FROM memories WHERE id = ?').get(local.memory.id).claim, local.memory.claim) }
  finally { backup.close() }
})

test('a historical delete-all stays limited to its original device after pairing and portable restore replay', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const oldMessages = local.db.all('SELECT id, content FROM raw_messages')
  const oldMemory = { ...local.memory }
  local.advance(1000)
  const deletion = deleteScope(local.db, local.repos, local.owner.principalId, { kind: 'all' }, local.now(), 7, local.config)
  assert.ok(deletion.removedMemories.includes(oldMemory.id))
  const remoteMessages = remote.db.all('SELECT id, content FROM raw_messages')
  const { payload, checksum } = pack(remote)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  confirmOwnerMerge(local.db, local.config, payload, checksum, preview)
  assert.ok(local.repos.getMemory(remote.memory.id))
  replayTombstones(local.db, local.repos, local.now() + 1, local.config)
  assert.ok(local.repos.getMemory(remote.memory.id), 'A local historical all selector must not grow onto remote memories')
  for (const row of remoteMessages) assert.equal(local.repos.getRawMessage(row.id).content, row.content)

  const restored = device(t, 'restore-target')
  const merged = pack(local, 'merged.companion.json')
  importPortable(restored.db, restored.config, merged.payload, merged.checksum, { nowMs: local.now() + 2 })
  // Simulate old rows reappearing while a backup is restored; the merged tombstone must still suppress only its old source.
  const columns = Object.keys(oldMemory)
  const resurrected = { ...oldMemory, principal_id: remote.owner.principalId }
  restored.db.run(`INSERT INTO memories (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(column => resurrected[column]))
  for (const row of oldMessages) restored.db.run('UPDATE raw_messages SET content = ?, deleted_at_ms = NULL WHERE id = ?', row.content, row.id)
  replayTombstones(restored.db, restored.repos, local.now() + 3, restored.config)
  assert.equal(restored.repos.getMemory(oldMemory.id), undefined)
  assert.ok(restored.repos.getMemory(remote.memory.id))
  for (const row of oldMessages) assert.notEqual(restored.repos.getRawMessage(row.id).deletedAtMs, null)
  for (const row of remoteMessages) {
    assert.equal(restored.repos.getRawMessage(row.id).content, row.content)
    assert.equal(restored.repos.getRawMessage(row.id).deletedAtMs, null)
  }
  assert.deepEqual(restored.db.all('PRAGMA foreign_key_check'), [])
})

test('an incoming historical delete-all preserves later memories from both devices and the original package lineage', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  remote.advance(1000)
  deleteScope(remote.db, remote.repos, remote.owner.principalId, { kind: 'all' }, remote.now(), 7, remote.config)
  remote.advance(1000)
  const laterRemoteMemory = remember(remote, '清空旧记忆以后在电脑 B 新记住的重要内容。')
  const { payload, checksum } = pack(remote)
  const originalPackage = stableJson(payload)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  confirmOwnerMerge(local.db, local.config, payload, checksum, preview)
  assert.equal(stableJson(payload), originalPackage, 'Freezing deletion scope must not rewrite the package or its lineage inventory')
  replayTombstones(local.db, local.repos, remote.now() + 1, local.config)
  assert.ok(local.repos.getMemory(local.memory.id))
  assert.ok(local.repos.getMemory(laterRemoteMemory.id))
  assert.equal(local.repos.getMemory(remote.memory.id), undefined)
  const merged = pack(local, 'merged-return.companion.json')
  importPortable(remote.db, remote.config, merged.payload, merged.checksum, { nowMs: remote.now() + 2 })
  replayTombstones(remote.db, remote.repos, remote.now() + 3, remote.config)
  assert.ok(remote.repos.getMemory(local.memory.id))
  assert.ok(remote.repos.getMemory(laterRemoteMemory.id))
  assert.equal(remote.repos.getMemory(remote.memory.id), undefined)
  assert.deepEqual(remote.db.all('PRAGMA foreign_key_check'), [])
})

test('an exception after owner adoption rolls back every table and retains the pre-confirmation backup', async t => {
  const local = await populated(t, 'A'), remote = await populated(t, 'B')
  const { payload, checksum } = pack(remote)
  const preview = previewOwnerMerge(local.db, local.config, payload, checksum)
  const before = databaseState(local.db), beforeBackups = new Set(backups(local))
  const originalRun = local.db.run.bind(local.db)
  let injected = false
  local.db.run = (sql, ...args) => {
    const result = originalRun(sql, ...args)
    if (!injected && backups(local).some(file => !beforeBackups.has(file))
      && local.repos.getSetting('owner.id') === payload.ownerId
      && /^(?:INSERT|UPDATE|DELETE)\b/i.test(sql.trim())) {
      injected = true
      throw Error('injected-owner-merge-transaction-failure')
    }
    return result
  }
  try {
    assert.throws(() => confirmOwnerMerge(local.db, local.config, payload, checksum, preview), /injected-owner-merge-transaction-failure/)
  } finally { local.db.run = originalRun }
  assert.equal(injected, true, 'The failure must occur after backup creation and actual owner adoption')
  assert.deepEqual(databaseState(local.db), before)
  assert.equal(local.owner.ownerId, preview.localOwnerId)
  const recovery = backups(local).filter(file => !beforeBackups.has(file))
  assert.ok(recovery.length >= 1)
  for (const file of recovery) {
    const backup = new DatabaseSync(file, { readOnly: true })
    try {
      assert.equal(backup.prepare("SELECT value FROM plugin_settings WHERE key = 'owner.id'").get().value, preview.localOwnerId)
      assert.ok(backup.prepare('SELECT id FROM memories WHERE id = ?').get(local.memory.id))
    } finally { backup.close() }
  }
})
