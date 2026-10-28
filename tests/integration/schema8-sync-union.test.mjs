import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { fixture } from '../helpers/fixture.mjs'
import { PRESETS } from '../../lib/domain/affect-reducer.js'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { FactUpdater } from '../../lib/memory/fact-updater.js'
import { Database } from '../../lib/storage/database.js'
import { Repositories } from '../../lib/storage/repositories.js'
import { loadMigrations, migrate } from '../../lib/storage/migrations.js'
import { continuousAffect, retractEmotionAppraisal, saveEmotionAppraisals } from '../../lib/storage/continuous-affect.js'
import { deleteScope, replayTombstones } from '../../lib/storage/deletion.js'
import { exportPortable, importPortable, readPortable, refreshPortableBaseline, stableJson } from '../../lib/storage/portable.js'
import { confirmOwnerMerge, previewOwnerMerge } from '../../lib/storage/owner-merge.js'

const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url))
const emotionTables = ['response_events', 'emotion_appraisals', 'emotion_appraisal_revisions']
const versionTwoTables = ['personality_profiles', 'personality_heads', 'episodic_annotations', 'expression_habits', 'memory_lifecycle', 'proactive_feedback', 'proactive_ownership']
const vector = { focus: 'action', agency: 'owner', desirability: .8, praiseworthiness: .9, relevance: .8, quote: 'thank you', confidence: .95 }

class FakeCloud {
  files = new Map()
  uploads = 0
  downloads = 0
  async list(directory) {
    return [...this.files.values()].filter(file => file.path.startsWith(directory + '/')).map(({ bytes, ...row }) => row)
  }
  async upload(path, bytes) {
    this.uploads++
    const prior = this.files.get(path)
    const file = { id: prior?.id ?? this.files.size + 1, path, name: path.split('/').at(-1), size: bytes.length,
      modifiedAtMs: 1000, bytes: Uint8Array.from(bytes) }
    this.files.set(path, file)
    return file
  }
  async download(file) {
    this.downloads++
    assert.ok(this.files.has(file.path), 'Only files published to this fake cloud may be downloaded')
    return Uint8Array.from(this.files.get(file.path).bytes)
  }
}

function device(t, label, cloud) {
  const f = fixture()
  // Remove the fixture's unrelated placeholder so owner adoption is checked on
  // exactly the two populated owners under test.
  f.db.run('DELETE FROM conversations WHERE id=?', f.binding.conversationId)
  f.db.run('DELETE FROM principals WHERE id=?', f.binding.principalId)
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), label)
  const binding = () => owner.binding('dsh', `schema-eight-${label}`, label, f.now())
  binding()
  const result = { ...f, owner, binding, label }
  if (cloud) {
    result.config = { ...f.config, storage: { ...f.config.storage, directory: f.directory }, cloud: { ...f.config.cloud, enabled: true } }
    result.transfer = new MemoryTransfer(f.db, result.config, label, { clientFactory: () => cloud })
    result.transfer.credentials.write({ appKey: 'fixture-key', secretKey: 'fixture-secret', appFolder: 'schema-eight-fixture', tokens: { accessToken: 'fixture-access' } })
  }
  t.after(async () => { await result.transfer?.stop(); f.close() })
  return result
}

function message(f, id, extra = {}) {
  const binding = typeof f.binding === 'function' ? f.binding() : f.binding
  return f.repos.insertRawMessage({ id, conversationId: binding.conversationId, platformMessageKey: id, role: 'user', sourceKind: 'dsh',
    content: `Remember ${id}: thank you for the help.`, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null, ...extra }).row
}

function remember(f, raw, id = `fact:${raw.id}`) {
  const binding = typeof f.binding === 'function' ? f.binding() : f.binding
  const outcome = f.updater.write({ id, principalId: binding.principalId, conversationId: raw.conversationId, visibility: 'private', kind: 'fact',
    subject: 'owner', predicate: id, object: { text: raw.content }, claim: raw.content, sourceKind: 'dsh', confidence: .95, salience: .8,
    eventAtMs: raw.occurredAtMs, observedAtMs: f.now(), evidence: [{ messageId: raw.id, quote: raw.content }] })
  assert.equal(outcome.type, 'inserted')
  return f.repos.getMemory(id)
}

function emotionalMessage(f, id, appraisal = vector, revise = false) {
  const raw = message(f, id), binding = f.binding()
  remember(f, raw)
  assert.equal(saveEmotionAppraisals(f.repos, binding, raw, [appraisal]), 1)
  if (revise) assert.equal(saveEmotionAppraisals(f.repos, binding, raw, [{ ...appraisal, relevance: .6 }]), 1)
  return raw
}

function pack(f, name) {
  const file = join(f.directory, `${name}.companion.json`)
  exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
  return { file, envelope: JSON.parse(readFileSync(file, 'utf8')), ...readPortable(file) }
}

function rows(db, table) {
  return db.all(`SELECT * FROM ${table} ORDER BY id`).map(row => {
    const { seq, ...portable } = row
    return { ...portable }
  })
}

function histories(f) {
  return Object.fromEntries(['raw_messages', 'memories', ...emotionTables].map(table => [table, rows(f.db, table)]))
}

function databaseState(db) {
  return Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({ name }) => [name,
    db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`).map(stableJson).sort(),
  ]))
}

async function sync(...devices) {
  for (const f of devices) {
    await f.transfer.sync()
    assert.equal(f.transfer.status().error, null, `${f.label}: ${f.transfer.status().error}`)
  }
}

function encodedLegacy(f, payload, name) {
  const bytes = Buffer.from(stableJson(payload))
  const file = join(f.directory, `${name}.companion.json`)
  writeFileSync(file, JSON.stringify({ format: 'dsh-companion-transfer', version: payload.version,
    sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') }))
  return readPortable(file)
}

test('schema 7 upgrades to original schema 8, backfilling only live human private responses and retaining every message and fact', t => {
  const f = fixture()
  t.after(() => f.close())
  const directory = join(f.directory, 'schema-seven-migrations')
  mkdirSync(directory)
  const migrations = loadMigrations(migrationsDirectory)
  assert.equal(migrations.find(item => item.version === 8).checksum, '3158aaa4fd3d5dc4e7dd8e37c59135cb')
  for (const migration of migrations.filter(item => item.version <= 7)) writeFileSync(join(directory, migration.name), migration.sql)
  const db = new Database({ file: join(f.directory, 'schema-seven.sqlite'), busyTimeoutMs: 1000 })
  try {
    migrate(db, { now: f.now(), fts5: true, directory })
    assert.equal(db.get('SELECT MAX(version) AS n FROM schema_migrations').n, 7)
    const repos = new Repositories(db)
    repos.ensureCompanion(f.config.companion.id, 'migration-fixture', PRESETS.balanced, f.now())
    repos.ensurePrincipal('old-owner', f.config.companion.id, 'owner', 'old-owner', f.now())
    repos.ensureConversation('old-private', 'old-owner', 'private', 'old-private', f.now())
    repos.ensureConversation('old-group', 'old-owner', 'group', 'old-group', f.now())
    const old = { ...f, db, repos, binding: { ...f.binding, principalId: 'old-owner', conversationId: 'old-private' }, updater: new FactUpdater(repos, f.config.memory) }
    const first = message(old, 'old-human-dsh')
    message(old, 'old-human-qq', { sourceKind: 'qq' })
    message(old, 'old-bridge', { sourceKind: 'codex-bridge' })
    message(old, 'old-assistant', { role: 'assistant' })
    message(old, 'old-deleted', { content: '', deletedAtMs: f.now() })
    message(old, 'old-group-user', { conversationId: 'old-group' })
    message(old, 'old-owner-statement', { sourceKind: 'owner_statement' })
    remember(old, first, 'old-fact')
    const messages = rows(db, 'raw_messages'), facts = rows(db, 'memories'), evidence = db.all('SELECT * FROM memory_evidence')
    assert.deepEqual(migrate(db, { now: f.now() + 1, fts5: true, directory: migrationsDirectory }).applied, [8, 9])
    assert.deepEqual(rows(db, 'raw_messages'), messages)
    assert.deepEqual(rows(db, 'memories'), facts)
    assert.deepEqual(db.all('SELECT * FROM memory_evidence'), evidence)
    assert.deepEqual(rows(db, 'response_events'), ['old-human-dsh', 'old-human-qq'].map(id => ({
      id: `response:${id}`, principal_id: 'old-owner', conversation_id: 'old-private', source_message_id: id,
      event_time_ms: f.now(), status: 'active', revision: 1,
    })))
    assert.equal(db.get('SELECT COUNT(*) AS n FROM emotion_appraisals').n, 0)
    assert.equal(db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n, 0)
    assert.deepEqual(migrate(db, { now: f.now() + 2, fts5: true, directory: migrationsDirectory }).applied, [])
    assert.equal(db.get('SELECT COUNT(*) AS n FROM response_events').n, 2)
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
  } finally { db.close() }
})

test('version 4 export/import preserves response withdrawal and revisions, emotion vectors and archives, and repeats without a single database change', t => {
  const a = device(t, 'roundtrip-a'), b = device(t, 'roundtrip-b')
  emotionalMessage(a, 'roundtrip-active', vector, true)
  emotionalMessage(a, 'roundtrip-withdrawn', vector, true)
  assert.equal(retractEmotionAppraisal(a.repos, 'emotion:roundtrip-withdrawn:0', a.owner.principalId), 1)
  a.db.run("UPDATE response_events SET revision=5 WHERE source_message_id='roundtrip-active'")
  a.db.run("UPDATE response_events SET status='retracted',revision=9 WHERE source_message_id='roundtrip-withdrawn'")
  const original = histories(a), state = continuousAffect(a.repos, a.config, a.owner.principalId, a.now())
  assert.equal(state.drives.responses, 1)
  assert.equal(state.appraisalCount, 1)
  assert.equal(original.emotion_appraisal_revisions.length, 3)
  const exported = pack(a, 'schema-eight-roundtrip')
  assert.equal(exported.envelope.version, 5)
  assert.equal(exported.payload.version, 5)
  assert.equal(exported.payload.formatVersion, 5)
  assert.equal(exported.payload.minReaderVersion, '0.3.0-dev.10')
  for (const table of emotionTables) assert.deepEqual(exported.payload.tables[table].slice().sort((x, y) => x.id.localeCompare(y.id)), original[table])
  assert.equal(importPortable(b.db, b.config, exported.payload, exported.checksum, { nowMs: b.now() }).alreadyImported, false)
  assert.equal(b.owner.ownerId, a.owner.ownerId)
  assert.deepEqual(histories(b), original)
  assert.deepEqual(continuousAffect(b.repos, b.config, b.owner.principalId, b.now()), state)
  const before = databaseState(b.db)
  assert.equal(importPortable(b.db, b.config, exported.payload, exported.checksum, { nowMs: b.now() + 1 }).alreadyImported, true)
  assert.deepEqual(databaseState(b.db), before)
  assert.deepEqual(b.db.all('PRAGMA foreign_key_check'), [])
})

test('two populated same-owner devices retain the union of offline messages, evidence-bound facts, vectors and archives through A/B/A cloud sync', async t => {
  const cloud = new FakeCloud(), a = device(t, 'union-a', cloud), b = device(t, 'union-b', cloud)
  emotionalMessage(a, 'common-anchor', vector, true)
  await sync(a, b, a)
  assert.equal(b.owner.ownerId, a.owner.ownerId)
  a.advance(60000); b.advance(60000)
  emotionalMessage(a, 'offline-a', vector, true)
  emotionalMessage(b, 'offline-b', { focus: 'event', affectedParty: 'self', desirability: -.7, relevance: .8, quote: 'thank you', confidence: .9 }, true)
  const left = histories(a), right = histories(b)
  const expected = Object.fromEntries(Object.keys(left).map(table => [table,
    [...new Map([...left[table], ...right[table]].map(row => [row.id, row])).values()].sort((x, y) => x.id.localeCompare(y.id)),
  ]))
  await sync(a, b, a)
  for (const f of [a, b]) {
    assert.deepEqual(histories(f), expected)
    const emotion = continuousAffect(f.repos, f.config, f.owner.principalId, f.now())
    assert.equal(emotion.drives.responses, 3)
    assert.equal(emotion.appraisalCount, 3)
    assert.deepEqual(new Set(emotion.evidenceIds), new Set(['common-anchor', 'offline-a', 'offline-b']))
    for (const id of ['common-anchor', 'offline-a', 'offline-b']) assert.deepEqual(f.repos.memoryEvidence(`fact:${id}`).map(item => item.messageId), [id])
    assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
  }
  assert.deepEqual(continuousAffect(a.repos, a.config, a.owner.principalId, a.now()), continuousAffect(b.repos, b.config, b.owner.principalId, b.now()))
  assert.ok(cloud.uploads > 0 && cloud.downloads > 0)
})

test('deleted sources and withdrawn response/emotion evidence cannot return after stale import, tombstone replay, late extraction or another cloud sync', async t => {
  const cloud = new FakeCloud(), a = device(t, 'delete-a', cloud), b = device(t, 'delete-b', cloud)
  const deleted = emotionalMessage(a, 'deleted-source', vector, true)
  emotionalMessage(a, 'withdrawn-source', vector, true)
  await sync(a, b, a)
  const stale = pack(b, 'stale-before-withdrawal')
  a.advance(1000); b.advance(1000)
  deleteScope(a.db, a.repos, a.owner.principalId, { kind: 'message', messageId: deleted.id }, a.now(), 7, a.config)
  assert.equal(retractEmotionAppraisal(a.repos, 'emotion:withdrawn-source:0', a.owner.principalId), 1)
  a.db.run("UPDATE response_events SET status='retracted',revision=7 WHERE source_message_id='withdrawn-source'")
  await sync(a, b, a)
  assert.equal(importPortable(a.db, a.config, stale.payload, stale.checksum, { nowMs: a.now() }).alreadyImported, false)
  for (const f of [a, b]) {
    replayTombstones(f.db, f.repos, f.now(), f.config)
    const deletedRaw = f.repos.getRawMessage('deleted-source')
    const deletedBinding = { ...f.binding(), conversationId: deletedRaw.conversationId }
    assert.throws(() => saveEmotionAppraisals(f.repos, deletedBinding, deletedRaw, [vector]), /Invalid emotion source owner/,
      'Late extraction from a deleted source must be rejected before inserting any appraisal')
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM emotion_appraisals WHERE source_message_id='deleted-source'").n, 0)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM response_events WHERE source_message_id='deleted-source' AND status='active'").n, 0)
    const raw = f.repos.getRawMessage('withdrawn-source')
    const sourceBinding = { ...f.binding(), conversationId: raw.conversationId }
    assert.equal(raw.deletedAtMs, null, 'The withdrawal case must retain its source text')
    assert.equal(saveEmotionAppraisals(f.repos, sourceBinding, raw, [vector]), 0, 'Late same-source extraction must honor the synchronized withdrawal')
  }
  await sync(a, b, a)
  for (const f of [a, b]) {
    const removed = f.repos.getRawMessage('deleted-source')
    assert.equal(removed.content, '')
    assert.notEqual(removed.deletedAtMs, null)
    assert.equal(f.repos.getMemory('fact:deleted-source'), undefined)
    assert.ok(f.repos.getMemory('fact:withdrawn-source'), 'Withdrawing an emotion does not discard an unrelated retained fact')
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM emotion_appraisals WHERE source_message_id='deleted-source'").n, 0)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM emotion_appraisal_revisions r JOIN emotion_appraisals a ON a.id=r.appraisal_id WHERE a.source_message_id='deleted-source'").n, 0)
    assert.equal(f.db.get("SELECT status FROM emotion_appraisals WHERE id='emotion:withdrawn-source:0'").status, 'retracted')
    const response = f.db.get("SELECT status,revision FROM response_events WHERE source_message_id='withdrawn-source'")
    assert.equal(response.status, 'retracted')
    assert.ok(response.revision >= 7)
    const state = continuousAffect(f.repos, f.config, f.owner.principalId, f.now())
    assert.equal(state.drives.responses, 0)
    assert.equal(state.appraisalCount, 0)
    assert.deepEqual(state.emotions, [])
    assert.deepEqual(state.evidenceIds, [])
    assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
  }
})

test('previewed owner adoption remaps all response and emotion ownership, retaining both source histories and every archived revision', t => {
  const local = device(t, 'adopt-local'), remote = device(t, 'adopt-remote')
  emotionalMessage(local, 'local-owner-active', vector, true)
  emotionalMessage(local, 'local-owner-withdrawn', vector, true)
  emotionalMessage(remote, 'remote-owner-active', vector, true)
  assert.equal(retractEmotionAppraisal(local.repos, 'emotion:local-owner-withdrawn:0', local.owner.principalId), 1)
  local.db.run("UPDATE response_events SET status='retracted',revision=6 WHERE source_message_id='local-owner-withdrawn'")
  remote.db.run("UPDATE response_events SET revision=4 WHERE source_message_id='remote-owner-active'")
  const previousPrincipal = local.owner.principalId, target = remote.owner.principalId
  const left = histories(local), right = histories(remote), source = pack(remote, 'adoption-source')
  const before = databaseState(local.db)
  const preview = previewOwnerMerge(local.db, local.config, source.payload, source.checksum)
  assert.deepEqual(preview.blockingConflicts, [])
  assert.ok(preview.report)
  assert.deepEqual(databaseState(local.db), before, 'Preview must roll back responses, vectors, revisions and ownership')
  const report = confirmOwnerMerge(local.db, local.config, source.payload, source.checksum, preview)
  assert.equal(report.alreadyImported, false)
  assert.equal(local.owner.ownerId, remote.owner.ownerId)
  assert.equal(local.owner.principalId, target)
  for (const table of Object.keys(left)) {
    const expected = [...left[table], ...right[table]].map(row => Object.hasOwn(row, 'principal_id') ? { ...row, principal_id: target } : row)
      .sort((x, y) => x.id.localeCompare(y.id))
    assert.deepEqual(rows(local.db, table), expected, `${table} must retain both histories under the adopted owner`)
  }
  for (const table of ['response_events', 'emotion_appraisals']) {
    assert.equal(local.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE principal_id<>?`, target).n, 0)
    assert.equal(local.db.get(`SELECT COUNT(*) AS n FROM ${table} e JOIN conversations c ON c.id=e.conversation_id WHERE c.principal_id<>e.principal_id`).n, 0)
  }
  assert.equal(local.db.get('SELECT id FROM principals WHERE id=?', previousPrincipal), undefined)
  assert.equal(local.db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n, 4)
  const state = continuousAffect(local.repos, local.config, target, local.now())
  assert.equal(state.drives.responses, 2)
  assert.equal(state.appraisalCount, 2)
  assert.deepEqual(new Set(state.evidenceIds), new Set(['local-owner-active', 'remote-owner-active']))
  const repeat = databaseState(local.db)
  assert.equal(confirmOwnerMerge(local.db, local.config, source.payload, source.checksum, preview).alreadyImported, true)
  assert.deepEqual(databaseState(local.db), repeat)
  assert.deepEqual(local.db.all('PRAGMA foreign_key_check'), [])
})

for (const version of [1, 2, 3]) test(`schema <=7 version ${version} file with no continuous-emotion tables still imports messages and facts without inventing appraisals`, t => {
  const source = device(t, `legacy-source-${version}`), target = device(t, `legacy-target-${version}`)
  const raw = message(source, `legacy-message-${version}`)
  remember(source, raw)
  const payload = structuredClone(pack(source, `legacy-base-${version}`).payload)
  payload.id = `legacy-schema-seven-version-${version}`
  payload.version = version
  payload.formatVersion = version
  delete payload.minReaderVersion
  payload.schema = payload.schema.filter(row => row.version <= 7)
  payload.ancestors = []
  for (const table of emotionTables) delete payload.tables[table]
  if (version === 1) for (const table of versionTwoTables) delete payload.tables[table]
  const legacy = encodedLegacy(source, payload, `legacy-version-${version}`)
  for (const table of emotionTables) assert.deepEqual(legacy.payload.tables[table], [])
  assert.equal(importPortable(target.db, target.config, legacy.payload, legacy.checksum, { nowMs: target.now() }).alreadyImported, false)
  assert.equal(target.owner.ownerId, source.owner.ownerId)
  assert.equal(target.repos.getRawMessage(raw.id).content, raw.content)
  assert.equal(target.repos.getMemory(`fact:${raw.id}`).claim, raw.content)
  assert.deepEqual(target.repos.memoryEvidence(`fact:${raw.id}`).map(row => row.messageId), [raw.id])
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM response_events').n, 1, 'Old human source messages still settle one response through the schema-eight insert trigger')
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM emotion_appraisals').n, 0)
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n, 0)
  const state = continuousAffect(target.repos, target.config, target.owner.principalId, target.now())
  assert.equal(state.drives.responses, 1)
  assert.equal(state.appraisalCount, 0)
  assert.deepEqual(state.emotions, [])
  assert.equal(refreshPortableBaseline(target.db, legacy.payload, legacy.checksum, target.now() + 1), true)
  assert.equal(refreshPortableBaseline(target.db, legacy.payload, legacy.checksum, target.now() + 2), true)
  const checkpoint = target.db.get('SELECT inventory_json FROM portable_checkpoints WHERE id=?', legacy.payload.id)
  assert.ok(checkpoint, 'A known legacy receipt must remain refreshable as a shared cloud anchor')
  for (const table of emotionTables) assert.equal(Object.hasOwn(JSON.parse(checkpoint.inventory_json), table), false,
    'Synthetic empty compatibility tables must not change the legacy package checkpoint identity')
  const before = databaseState(target.db)
  assert.equal(importPortable(target.db, target.config, legacy.payload, legacy.checksum).alreadyImported, true)
  assert.deepEqual(databaseState(target.db), before)
  assert.deepEqual(target.db.all('PRAGMA foreign_key_check'), [])
})
