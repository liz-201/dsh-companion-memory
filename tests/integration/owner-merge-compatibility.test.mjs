import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fixture, appreciation } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'
import { deleteScope, replayTombstones } from '../../lib/storage/deletion.js'
import { exportPortable, importPortable, readPortable, stableJson } from '../../lib/storage/portable.js'
import { previewOwnerMerge, confirmOwnerMerge } from '../../lib/storage/owner-merge.js'

function device(t, label) {
  const f = fixture({ events: [appreciation] })
  t.after(() => f.close())
  f.db.run('DELETE FROM conversations WHERE id = ?', f.binding.conversationId)
  f.db.run('DELETE FROM principals WHERE id = ?', f.binding.principalId)
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), label)
  const binding = () => owner.binding('dsh', `compatibility-${label}`, label, f.now())
  binding()
  return { ...f, owner, binding, label }
}

async function populate(f, id) {
  await f.turn(`重要原话 ${id}`, { binding: f.binding() })
  const before = new Set(f.db.all('SELECT id FROM memories').map(row => row.id))
  const result = handleFishCommand({ binding: f.binding(), raw: `remember 需要跨版本保护的记忆 ${id}`, isOwner: true, nowMs: f.now() }, {
    config: f.config, db: f.db, repos: f.repos, updater: f.updater, retriever: f.retriever, metrics: f.metrics,
  })
  assert.equal(result.kind, 'success')
  const memory = f.db.all('SELECT id FROM memories').find(row => !before.has(row.id))
  assert.ok(memory)
  return memory.id
}

function pack(f, name) {
  const file = join(f.directory, `${name}.companion.json`)
  exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
  return { file, envelope: JSON.parse(readFileSync(file, 'utf8')), ...readPortable(file) }
}

function state(db) {
  return Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(({ name }) => [name,
    db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`).map(row => stableJson(row)).sort(),
  ]))
}

async function paired(t, { deleteLocal = false } = {}) {
  const local = device(t, 'local'), remote = device(t, 'remote')
  const localMemory = await populate(local, 'local'), remoteMemory = await populate(remote, 'remote')
  const oldPrincipal = local.owner.principalId
  if (deleteLocal) {
    local.advance(1000)
    deleteScope(local.db, local.repos, oldPrincipal, { kind: 'all' }, local.now(), 7, local.config)
  }
  const source = pack(remote, 'pair-source')
  const preview = previewOwnerMerge(local.db, local.config, source.payload, source.checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  confirmOwnerMerge(local.db, local.config, source.payload, source.checksum, preview)
  return { local, remote, localMemory, remoteMemory, oldPrincipal }
}

function encodedFile(f, payload, name, envelopeVersion = payload.version) {
  const bytes = Buffer.from(stableJson(payload))
  const file = join(f.directory, `${name}.companion.json`)
  writeFileSync(file, JSON.stringify({ format: 'dsh-companion-transfer', version: envelopeVersion,
    sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') }))
  return file
}

test('an ordinary unpaired library continues exporting version two for existing readers', async t => {
  const f = device(t, 'ordinary')
  await populate(f, 'ordinary')
  const exported = pack(f, 'ordinary-export')
  assert.equal(exported.envelope.version, 2)
  assert.equal(exported.payload.version, 2)
  assert.equal(exported.payload.formatVersion, 2)
  assert.equal(f.repos.getSetting('memory.owner-merge-version'), undefined)
  assert.ok(!exported.payload.tables.plugin_settings.some(row => row.key === 'memory.owner-merge-version'))
})

test('an explicitly paired library advertises version three and the dev eight minimum reader in both its file layers', async t => {
  const { local } = await paired(t)
  const exported = pack(local, 'paired-export')
  assert.equal(local.repos.getSetting('memory.owner-merge-version'), '1')
  assert.equal(exported.envelope.version, 3)
  assert.equal(exported.payload.version, 3)
  assert.equal(exported.payload.formatVersion, 3)
  assert.equal(exported.payload.minReaderVersion, '0.3.0-dev.8')
  assert.ok(exported.payload.tables.plugin_settings.some(row => row.key === 'memory.owner-merge-version' && row.value === '1'))
})

test('dev eight restores and round-trips version three without losing either history or downgrading later exports', async t => {
  const { local, remote, localMemory, remoteMemory } = await paired(t)
  const originalEvents = local.db.all('SELECT id, payload_json, status FROM affect_events ORDER BY id')
  const exported = pack(local, 'version-three')
  const restored = device(t, 'restored')
  importPortable(restored.db, restored.config, exported.payload, exported.checksum, { nowMs: local.now() + 1 })
  assert.equal(restored.owner.ownerId, local.owner.ownerId)
  assert.ok(restored.repos.getMemory(localMemory))
  assert.ok(restored.repos.getMemory(remoteMemory))
  assert.equal(restored.repos.getSetting('memory.owner-merge-version'), '1')
  assert.deepEqual(restored.db.all('SELECT id, payload_json, status FROM affect_events ORDER BY id'), originalEvents)
  const returned = pack(restored, 'returned-version-three')
  assert.equal(returned.envelope.version, 3)
  importPortable(remote.db, remote.config, returned.payload, returned.checksum, { nowMs: local.now() + 2 })
  assert.ok(remote.repos.getMemory(localMemory))
  assert.ok(remote.repos.getMemory(remoteMemory))
  assert.equal(remote.repos.getSetting('memory.owner-merge-version'), '1')
  assert.equal(pack(remote, 'source-after-roundtrip').payload.version, 3)
  const beforeRepeat = state(remote.db)
  assert.equal(importPortable(remote.db, remote.config, returned.payload, returned.checksum).alreadyImported, true)
  assert.deepEqual(state(remote.db), beforeRepeat)
  assert.deepEqual(remote.db.all('PRAGMA foreign_key_check'), [])
})

test('a simulated dev six reader rejects the version-three envelope before importing, consuming or publishing anything', async t => {
  const { local } = await paired(t)
  const exported = pack(local, 'protected-from-old-readers')
  const legacy = device(t, 'legacy')
  const legacyMemory = await populate(legacy, 'legacy-local')
  const before = state(legacy.db), originalFile = readFileSync(exported.file)
  let consumed = 0, published = 0
  // This is the dev.6 envelope allow-list, deliberately independent of the current reader.
  const simulateLegacySync = file => {
    const envelope = JSON.parse(readFileSync(file, 'utf8'))
    if (envelope.format !== 'dsh-companion-transfer' || ![1, 2].includes(Number(envelope.version))) {
      throw Error('Unsupported transfer package')
    }
    const source = readPortable(file)
    importPortable(legacy.db, legacy.config, source.payload, source.checksum)
    consumed++
    published++
  }
  assert.throws(() => simulateLegacySync(exported.file), /Unsupported transfer package/)
  assert.equal(consumed, 0)
  assert.equal(published, 0)
  assert.deepEqual(state(legacy.db), before)
  assert.ok(legacy.repos.getMemory(legacyMemory))
  assert.deepEqual(readFileSync(exported.file), originalFile)
})

test('a version-three source can itself be previewed and explicitly paired with a third populated device', async t => {
  const { local, localMemory, remoteMemory } = await paired(t)
  const source = pack(local, 'already-paired-source')
  const third = device(t, 'third'), thirdMemory = await populate(third, 'third')
  assert.equal(source.payload.version, 3)
  const preview = previewOwnerMerge(third.db, third.config, source.payload, source.checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  confirmOwnerMerge(third.db, third.config, source.payload, source.checksum, preview)
  assert.equal(third.owner.ownerId, source.payload.ownerId)
  for (const id of [localMemory, remoteMemory, thirdMemory]) assert.ok(third.repos.getMemory(id))
  assert.equal(third.repos.activeAffectEvents(third.owner.principalId).length, 3)
  assert.equal(pack(third, 'three-device-export').envelope.version, 3)
  assert.deepEqual(third.db.all('PRAGMA foreign_key_check'), [])
})

test('a previously paired dev seven library with aliases but no explicit capability marker exports version three after upgrading', async t => {
  const { local, oldPrincipal } = await paired(t)
  local.db.run("DELETE FROM plugin_settings WHERE key = 'memory.owner-merge-version'")
  assert.equal(local.repos.getSetting('memory.owner-merge-version'), undefined)
  assert.ok(local.repos.getSetting(`identity.shared-alias:${oldPrincipal}`))
  const upgraded = pack(local, 'old-dev-seven-aliases')
  assert.equal(upgraded.envelope.version, 3)
  assert.equal(upgraded.payload.minReaderVersion, '0.3.0-dev.8')
})

test('importing version three persists the format capability even when the incoming rows omit its marker', async t => {
  const { local } = await paired(t)
  const exported = pack(local, 'v3-for-unmarked-input')
  const payload = structuredClone(exported.payload)
  payload.tables.plugin_settings = payload.tables.plugin_settings.filter(row => row.key !== 'memory.owner-merge-version'
    && !row.key.startsWith('identity.shared-alias:'))
  const verified = readPortable(encodedFile(local, payload, 'v3-without-capability-row'))
  const restored = device(t, 'restore-unmarked-v3')
  importPortable(restored.db, restored.config, verified.payload, verified.checksum)
  assert.equal(restored.repos.getSetting('memory.owner-merge-version'), '1')
  assert.equal(pack(restored, 'unmarked-v3-reexport').envelope.version, 3)
})

for (const change of ['delete', 'downgrade']) {
  test(`a version-two peer cannot ${change} an adopted library's minimum-format capability marker`, async t => {
    const { local } = await paired(t)
    const baseline = pack(local, `baseline-for-${change}`)
    const peer = device(t, `legacy-peer-${change}`)
    importPortable(peer.db, peer.config, baseline.payload, baseline.checksum)
    // Model an older writer that carries a common inventory but omits or resets the capability it does not implement.
    peer.db.run("DELETE FROM plugin_settings WHERE key LIKE 'identity.shared-alias:%'")
    if (change === 'delete') peer.db.run("DELETE FROM plugin_settings WHERE key = 'memory.owner-merge-version'")
    else peer.repos.setSetting('memory.owner-merge-version', '0', peer.now())
    const olderPackage = pack(peer, `older-writer-${change}`)
    assert.equal(olderPackage.envelope.version, 2)
    importPortable(local.db, local.config, olderPackage.payload, olderPackage.checksum)
    assert.equal(local.repos.getSetting('memory.owner-merge-version'), '1')
    assert.equal(pack(local, `protected-after-${change}`).envelope.version, 3)
  })
}

test('version three still requires every transfer table and rejects mismatched envelope versions', async t => {
  const { local } = await paired(t)
  const source = pack(local, 'complete-version-three')
  for (const table of ['memories', 'personality_heads']) {
    const incomplete = structuredClone(source.payload)
    delete incomplete.tables[table]
    const file = encodedFile(local, incomplete, `missing-${table}`)
    assert.throws(() => readPortable(file), /missing|Invalid|Unsupported/i)
  }
  const mislabeled = encodedFile(local, source.payload, 'v3-inside-v2-envelope', 2)
  assert.throws(() => readPortable(mislabeled), /Invalid|Unsupported/i)
})

test('paired alias and recorded-only tombstone semantics remain version three after restore and deletion replay', async t => {
  const { local, localMemory, remoteMemory, oldPrincipal } = await paired(t, { deleteLocal: true })
  const source = pack(local, 'paired-deletion-and-aliases')
  assert.equal(source.envelope.version, 3)
  assert.equal(source.payload.version, 3)
  assert.ok(source.payload.tables.plugin_settings.some(row => row.key === `identity.shared-alias:${oldPrincipal}`))
  assert.ok(source.payload.tables.deletion_tombstones.some(row => {
    const selector = JSON.parse(row.selector_json)
    return selector.kind === 'all' && selector.recordedOnly === true
  }))
  const restored = device(t, 'restore-special-semantics')
  importPortable(restored.db, restored.config, source.payload, source.checksum)
  replayTombstones(restored.db, restored.repos, local.now() + 1, restored.config)
  assert.equal(restored.repos.getMemory(localMemory), undefined)
  assert.ok(restored.repos.getMemory(remoteMemory))
  const returned = pack(restored, 'special-semantics-reexport')
  assert.equal(returned.envelope.version, 3, 'A restored package with new deletion/alias semantics must never look like version two')
  assert.equal(returned.payload.minReaderVersion, '0.3.0-dev.8')
})
