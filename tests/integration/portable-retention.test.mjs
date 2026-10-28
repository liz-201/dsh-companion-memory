import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { Database } from '../../lib/storage/database.js'
import { exportPortable, readPortable, importPortable, prunePortableCheckpoints } from '../../lib/storage/portable.js'
import { StartupSync } from '../../lib/storage/startup-sync.js'
import { resolveConfig } from '../../lib/config.js'
import { deleteScope } from '../../lib/storage/deletion.js'

test('same-content exports deduplicate lineage inventories while retaining package receipts', t => {
  const f = fixture(); t.after(() => f.close())
  new OwnerIdentity(f.repos, f.config)
  for (let i = 0; i < 3; i++) {
    const file = join(f.directory, `${i}.json`)
    exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() + i })
    const read = readPortable(file)
    assert.equal(importPortable(f.db, f.config, read.payload, read.checksum).alreadyImported, true, 'An own export must never be merged as foreign data')
  }
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM portable_checkpoints').n, 1)
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM portable_imports').n, 3)
})

test('checkpoint retention stays bounded and pruning does not re-import older own files', t => {
  const f = fixture(); t.after(() => f.close())
  new OwnerIdentity(f.repos, f.config)
  const first = join(f.directory, 'old.json')
  for (let i = 0; i < 24; i++) {
    f.repos.setSetting('retention.test', String(i), f.now() + i)
    const file = i === 0 ? first : join(f.directory, `state-${i}.json`)
    exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() + i })
    const { payload } = readPortable(file)
    assert.equal(payload.version, 3)
    assert.ok(payload.ancestors.length <= 8)
  }
  assert.ok(f.db.get('SELECT COUNT(*) AS n FROM portable_checkpoints').n <= 8)
  const dir = join(f.directory, 'transfer'); mkdirSync(dir)
  copyFileSync(first, join(dir, 'old-own.companion.json'))
  const sync = new StartupSync(f.db, { ...f.config, storage: { ...f.config.storage, directory: f.directory } })
  sync.importAtStartup()
  assert.deepEqual(sync.reports, [])
  assert.equal(f.repos.getSetting('retention.test'), '23')
})

test('pruning legacy inventories limits their total bytes and leaves the freed pages reusable', t => {
  const f = fixture(); t.after(() => f.close())
  for (let i = 0; i < 30; i++) f.db.run('INSERT INTO portable_checkpoints VALUES (?, ?, ?)', `legacy-${i}`, JSON.stringify({ raw_messages: { [`id-${i}`]: 'a'.repeat(150000) } }), f.now() + i)
  const result = prunePortableCheckpoints(f.db)
  assert.ok(result.retained <= 8)
  assert.ok(result.bytes <= 1024 * 1024)
  assert.ok(result.removed > 0)
  assert.ok(f.db.get('PRAGMA freelist_count').freelist_count > 0)
})

test('publish avoids unchanged table scans and notices writes through another database connection', t => {
  const f = fixture(); t.after(() => f.close())
  new OwnerIdentity(f.repos, f.config)
  const sync = new StartupSync(f.db, { ...f.config, storage: { ...f.config.storage, directory: f.directory } })
  sync.publish('A')
  const before = readFileSync(sync.lastExport, 'utf8')
  const all = f.db.all.bind(f.db)
  let scans = 0
  f.db.all = (sql, ...args) => { if (sql.startsWith('SELECT * FROM ')) scans++; return all(sql, ...args) }
  for (let i = 0; i < 100; i++) sync.publish('A')
  assert.equal(scans, 0)
  const other = new Database({ file: f.db.file, busyTimeoutMs: 1000 })
  try {
    other.run("INSERT INTO plugin_settings(key,value,updated_at_ms) VALUES ('retention.external','changed',?)", f.now())
    sync.publish('A')
    assert.notEqual(readFileSync(sync.lastExport, 'utf8'), before)
    assert.ok(scans > 0)
  } finally { other.close() }
  assert.equal(resolveConfig({}).storage.syncIntervalSeconds, 300)
  assert.throws(() => resolveConfig({ storage: { syncIntervalSeconds: 0 } }))
})

test('two deletions in the same millisecond return their exact distinct tombstone IDs', t => {
  const f = fixture(); t.after(() => f.close())
  const first = deleteScope(f.db, f.repos, 'p', { kind: 'memory', memoryId: 'missing-one' }, f.now(), 7, f.config)
  const second = deleteScope(f.db, f.repos, 'p', { kind: 'memory', memoryId: 'missing-two' }, f.now(), 7, f.config)
  assert.notEqual(first.tombstoneId, second.tombstoneId)
  const row = f.db.get('SELECT selector_json FROM deletion_tombstones WHERE id = ?', second.tombstoneId)
  assert.equal(JSON.parse(row.selector_json).memoryId, 'missing-two')
})

test('an offline peer still merges new messages and deletion tombstones after older lineage was pruned', t => {
  const a = fixture(), b = fixture()
  t.after(() => { a.close(); b.close() })
  const owner = new OwnerIdentity(a.repos, a.config), binding = owner.binding('dsh', 'shared')
  const raw = (f, id) => f.repos.insertRawMessage({ id, conversationId: binding.conversationId, platformMessageKey: id, role: 'user', sourceKind: 'dsh', content: `用户消息 ${id}`, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
  const transfer = (from, to, name) => {
    const file = join(from.directory, name)
    exportPortable(from.db, from.config, file, { includePlugin: false })
    const read = readPortable(file)
    return importPortable(to.db, to.config, read.payload, read.checksum)
  }
  raw(a, 'delete-me')
  transfer(a, b, 'base.json')
  deleteScope(a.db, a.repos, binding.principalId, { kind: 'message', messageId: 'delete-me' }, a.now(), 7, a.config)
  for (let i = 0; i < 15; i++) {
    raw(a, `a-${i}`)
    exportPortable(a.db, a.config, join(a.directory, `advance-${i}.json`), { includePlugin: false })
  }
  assert.ok(a.db.get('SELECT COUNT(*) AS n FROM portable_checkpoints').n <= 8)
  raw(b, 'branch-b')
  transfer(b, a, 'return.json')
  transfer(a, b, 'merged.json')
  for (const f of [a, b]) {
    assert.notEqual(f.repos.getRawMessage('delete-me').deletedAtMs, null)
    assert.equal(f.repos.getRawMessage('branch-b').deletedAtMs, null)
    assert.equal(f.repos.getRawMessage('a-14').deletedAtMs, null)
    assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
  }
})
