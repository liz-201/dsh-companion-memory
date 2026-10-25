import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { exportPortable, readPortable, importPortable, stableJson } from '../../lib/storage/portable.js'
import { StartupSync } from '../../lib/storage/startup-sync.js'
import { Consolidator, memoryIdFor } from '../../lib/memory/consolidator.js'

// REVIEW-20261025-01 的 A（episode id 碰撞）与 B（无共同祖先的静默降级 + legacy receipt）。
// C（consolidation-output 游标）由并行一侧负责，这里不覆盖。

const CONTENT = '我住在杭州，平时喜欢喝冰美式。'

function batchFor(f) {
  f.repos.insertRawMessage({ id: 'source', conversationId: 'c', platformMessageKey: 'source', role: 'user', sourceKind: 'dsh',
    content: CONTENT, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
  return new Consolidator(f.repos, f.config.background, f.updater).planBatch({ conversationId: 'c', principalId: 'p', afterSeq: 0 })
}

function episode(claim, quote = '我住在杭州') {
  return { kind: 'episode', subject: null, predicate: null, object: null, claim, quote, sourceMessageIds: ['source'],
    confidence: .6, salience: .5, eventAtMs: null }
}

function raw(f, id, content) {
  f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh',
    content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
}

function transferDirectory(f) {
  const directory = join(f.directory, 'transfer')
  mkdirSync(directory, { recursive: true })
  return directory
}

function syncFor(f) {
  return new StartupSync(f.db, { ...f.config, storage: { ...f.config.storage, directory: f.directory } })
}

// ── A：null-key episode 不再共用 id ────────────────────────────────────────────

test('two episodes without subject or predicate keep separate identities and both claims survive', t => {
  const f = fixture(); t.after(() => f.close())
  const batch = batchFor(f)
  const consolidator = new Consolidator(f.repos, f.config.background, f.updater)
  const plan = { changes: [episode('第一次一起喝冰美式'), episode('她说杭州下雨了', '平时喜欢喝冰美式')], cursor: batch.cursor }
  const applied = consolidator.applyPlan(batch, plan, f.now())
  assert.equal(applied.applied, 2)
  const claims = f.db.all("SELECT claim FROM memories WHERE kind = 'episode'").map(row => row.claim)
  assert.equal(claims.length, 2, '两条 null-key episode 必须落成两行，不能撞成一行')
  assert.deepEqual(new Set(claims), new Set(['第一次一起喝冰美式', '她说杭州下雨了']))

  const replay = consolidator.applyPlan(batch, plan, f.now())
  // applied 计的是“被接受并入账的变更数”，重放仍会再计 2；幂等性落在行层面。
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM memories WHERE kind = 'episode'").n, 2, '重放同一批不能新增行')
  assert.deepEqual(replay.touchedIds, applied.touchedIds, '重放必须命中同一批记忆 id')
})

test('episode identity uses the whole claim, so a shared eighty-character prefix still differs', () => {
  const prefix = '她'.repeat(80)
  const first = episode(`${prefix}甲`), second = episode(`${prefix}乙`)
  assert.notEqual(memoryIdFor('p', first), memoryIdFor('p', second))
})

test('fact identity stays exactly as before: keyed by subject, predicate and object, never by claim', () => {
  const fact = { kind: 'fact', subject: '用户', predicate: '居住地', object: '杭州', claim: '用户住在杭州' }
  assert.equal(memoryIdFor('p', fact), memoryIdFor('p', { ...fact, claim: '换了说法但同一事实' }))
  assert.notEqual(memoryIdFor('p', fact), memoryIdFor('p', { ...fact, object: '上海' }))
  assert.notEqual(memoryIdFor('p', fact), memoryIdFor('p', { ...fact, predicate: '出生地' }))
})

test('a literal "-" subject and predicate is a real key, not a missing one', () => {
  const sentinel = { kind: 'fact', subject: '-', predicate: '-', object: '甲', claim: '第一句' }
  assert.equal(memoryIdFor('p', sentinel), memoryIdFor('p', { ...sentinel, claim: '完全不同的说法' }), '"-" 是真实键，不能当成缺键把 claim 混进 id')
  assert.notEqual(memoryIdFor('p', sentinel), memoryIdFor('p', { ...sentinel, object: '乙' }))
})

test('episode identity ignores surrounding whitespace, matching the claim that gets stored', () => {
  assert.equal(memoryIdFor('p', episode('  她说杭州下雨了  ')), memoryIdFor('p', episode('她说杭州下雨了')))
})

// ── B：无共同祖先时显式降级，不擅自覆盖 ──────────────────────────────────────
test('a package with no shared ancestor is reported, audited and never overwrites divergent local rows', t => {
  const a = fixture(), b = fixture()
  t.after(() => { a.close(); b.close() })
  const ownA = new OwnerIdentity(a.repos, a.config)
  new OwnerIdentity(b.repos, b.config)
  raw(a, 'shared', '甲版本的内容')
  raw(b, 'shared', '乙版本的内容')
  b.repos.setSetting('owner.id', ownA.ownerId, b.now())

  const file = join(a.directory, 'divergent.json')
  exportPortable(a.db, a.config, file, { includePlugin: false, nowMs: a.now() })
  const read = readPortable(file)
  const report = importPortable(b.db, b.config, read.payload, read.checksum, { nowMs: b.now() })

  assert.equal(report.lineageMissing, true, '祖先全缺必须显式报告，不能静默降级')
  assert.equal(b.repos.getRawMessage('shared').content, '乙版本的内容', '没有 base 时不能擅自覆盖已有内容')
  assert.ok(report.conflicts >= 1, '差异行必须以冲突形式留下，而不是消失')
  const conflict = b.db.get("SELECT local_json, incoming_json FROM portable_conflicts WHERE table_name = 'raw_messages'")
  assert.match(conflict.local_json, /乙版本/)
  assert.match(conflict.incoming_json, /甲版本/)
  const audit = b.db.get("SELECT seq, principal_id, payload_json FROM audit_events WHERE kind = 'portable-import-no-lineage'")
  assert.ok(audit, '降级必须留审计')
  assert.equal(audit.principal_id, ownA.principalId, '审计必须指向包内真实的 owner principal')
  assert.equal(JSON.parse(audit.payload_json).conflicts, report.conflicts, '审计里的冲突数必须是真实值，不能恒为 0')
  assert.deepEqual(b.db.all('PRAGMA foreign_key_check'), [])
})

test('a first import into an empty database is not reported as missing lineage', t => {
  const a = fixture(), b = fixture()
  t.after(() => { a.close(); b.close() })
  new OwnerIdentity(a.repos, a.config)
  raw(a, 'first', '首次同步的内容')
  const file = join(a.directory, 'first.json')
  exportPortable(a.db, a.config, file, { includePlugin: false, nowMs: a.now() })
  const read = readPortable(file)
  const report = importPortable(b.db, b.config, read.payload, read.checksum, { nowMs: b.now() })

  assert.equal(report.lineageMissing, false, '空库导入没有可保护的数据，不能误报降级')
  assert.equal(b.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'portable-import-no-lineage'").n, 0)
  assert.equal(b.repos.getRawMessage('first').content, '首次同步的内容')
})

test('a legacy own export without a receipt is recognised by its checkpoint and blocked again after pruning', t => {
  const f = fixture(); t.after(() => f.close())
  new OwnerIdentity(f.repos, f.config)
  const file = join(f.directory, 'own.json')
  const { id } = exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
  f.db.run('DELETE FROM portable_imports') // 旧版本导出：只有 checkpoint，没有 receipt
  copyFileSync(file, join(transferDirectory(f), 'legacy-copy.companion.json'))

  const sync = syncFor(f)
  sync.importAtStartup()
  assert.deepEqual(sync.reports, [])
  assert.equal(f.db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', id)?.checksum !== undefined, true, '旧自身包必须补上 receipt')

  f.db.run('DELETE FROM portable_checkpoints') // 裁剪掉 checkpoint，只剩 receipt
  const afterPruning = syncFor(f)
  afterPruning.importAtStartup()
  assert.deepEqual(afterPruning.reports, [], 'receipt 必须继续挡住旧副本')
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM portable_imports WHERE package_id = ?', id).n, 1)
})

test('a file that reuses a known package id with different content is rejected, not blessed', t => {
  const f = fixture(); t.after(() => f.close())
  new OwnerIdentity(f.repos, f.config)
  const file = join(f.directory, 'own.json')
  const { id } = exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
  const original = f.db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', id).checksum

  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  const payload = JSON.parse(gunzipSync(Buffer.from(envelope.data, 'base64')).toString('utf8'))
  payload.tables.raw_messages.push({ id: 'forged', conversation_id: 'c', role: 'user', content: '伪造内容' })
  const bytes = Buffer.from(stableJson(payload))
  const tampered = { ...envelope, sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') }
  writeFileSync(join(transferDirectory(f), 'tampered.companion.json'), JSON.stringify(tampered))

  const sync = syncFor(f)
  sync.importAtStartup()
  assert.equal(sync.reports.length, 1)
  assert.match(String(sync.reports[0].error), /reused with different content/)
  assert.equal(f.db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', id).checksum, original, 'receipt 不能被伪造包改写')
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM raw_messages WHERE id = 'forged'").n, 0)
})

test('an unknown package from another device is imported instead of being mistaken for an own export', t => {
  const a = fixture(), b = fixture()
  t.after(() => { a.close(); b.close() })
  new OwnerIdentity(a.repos, a.config)
  raw(a, 'foreign', '外来设备的内容')
  const file = join(a.directory, 'foreign.json')
  exportPortable(a.db, a.config, file, { includePlugin: false, nowMs: a.now() })
  copyFileSync(file, join(transferDirectory(b), 'peer.companion.json'))

  const sync = syncFor(b)
  sync.importAtStartup()
  assert.equal(b.repos.getRawMessage('foreign').content, '外来设备的内容')
  assert.equal(sync.reports.length, 1)
  assert.equal(sync.reports[0].error, undefined)
  assert.equal(sync.reports[0].lineageMissing, false)
})
