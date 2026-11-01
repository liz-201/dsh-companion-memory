import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture } from '../helpers/fixture.mjs'
import { learnExplicitHabit, activeHabits } from '../../lib/memory/habit-learning.js'
import { detectSourceKind, isHumanMessage } from '../../lib/memory/source-policy.js'
import { Consolidator } from '../../lib/memory/consolidator.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { checkGates } from '../../lib/proactive/candidate-builder.js'
import { backupNow } from '../../lib/storage/backup.js'
import { deleteScope, replayTombstones } from '../../lib/storage/deletion.js'
import { restoreBackup } from '../../lib/storage/restore.js'
import { openDatabase } from '../../lib/storage/database.js'
import { Repositories, UNKNOWN_DELIVERY_GRACE_MS } from '../../lib/storage/repositories.js'

function raw(f, id, sourceKind = 'dsh', content = '以后回复少分点，别写小作文') {
  return f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind,
    content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row
}

test('bridge and unknown sources cannot teach habits, including old active habits and implicit proposals', t => {
  const f = fixture(); t.after(() => f.close())
  for (const source of ['codex-bridge', 'tool', 'unknown', 'replay']) {
    const message = raw(f, source, source)
    learnExplicitHabit(f.repos, f.binding, message)
  }
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM expression_habits').n, 0)
  // Emulate a habit created by the old code, then change its source to the actual bridge provenance.
  const legacy = raw(f, 'legacy')
  learnExplicitHabit(f.repos, f.binding, legacy)
  f.db.run("UPDATE raw_messages SET source_kind = 'codex-bridge' WHERE id = 'legacy'")
  assert.deepEqual(activeHabits(f.repos, f.binding, f.now()), [])
  learnExplicitHabit(f.repos, f.binding, raw(f, 'human-short', 'qq', '好'))
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM expression_habits WHERE kind = 'implicit_verbosity'").n, 0)
  for (const source of ['dsh', 'desktop', 'qq']) {
    const message = raw(f, `human-${source}`, source)
    learnExplicitHabit(f.repos, f.binding, message)
    assert.deepEqual(activeHabits(f.repos, f.binding, f.now()).map(h => h.sources), [[message.id]])
  }
})

test('bridge text arriving on a human channel is marked at ingress and cannot teach habits', t => {
  const f = fixture(); t.after(() => f.close())
  // 桥接回信走的是普通 user/message 事件，若不标记就会被当成 dsh 人类消息。
  const bridge = detectSourceKind('[Codex 协作回复 / mailbox dsh-x-20261026]\n请只读复核这三条缺陷', 'dsh')
  assert.equal(bridge, 'codex-bridge')
  assert.equal(isHumanMessage(raw(f, 'bridge-ingress', bridge, '请只读复核这三条缺陷')), false)
  learnExplicitHabit(f.repos, f.binding, raw(f, 'bridge-ingress-2', bridge, '以后回复少分点，别写小作文'))
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM expression_habits').n, 0)
  // 同一入口下，主人自己说的话必须保持人类来源，否则会把正常学习也堵死。
  assert.equal(detectSourceKind('以后回复少分点，别写小作文', 'dsh'), 'dsh')
  const human = raw(f, 'human-ingress', detectSourceKind('以后回复少分点，别写小作文', 'dsh'), '以后回复少分点，别写小作文')
  assert.equal(isHumanMessage(human), true)
  learnExplicitHabit(f.repos, f.binding, human)
  assert.deepEqual(activeHabits(f.repos, f.binding, f.now()).map(h => h.sources), [[human.id]])
})

test('unknown delivery counts only inside the grace window so proactivity cannot stall forever', t => {
  const f = fixture(); t.after(() => f.close())
  f.repos.ensureConversation('peer', 'p', 'private', 'private:peer', f.now())
  for (const [id, offset] of [['stale', -3 * 24 * 3600_000], ['fresh', -3600_000]]) {
    f.repos.enqueueOutbox({ id, conversationId: 'c', turnId: null, candidateKey: id, taskId: null,
      content: '问一句', contentHash: id, plannedAtMs: f.now() + offset, expectedInboundSeq: 0 })
    f.db.run("UPDATE outbox SET status = 'unknown' WHERE id = ?", id)
  }
  // 不传截止时间保持旧行为：两条都算未回复。
  assert.deepEqual(f.repos.unresolvedOutbox('peer', 0).map(row => row.id), ['stale', 'fresh'])
  // 传了截止时间后，早于宽限期的 unknown 按未送达处理，只剩新鲜的那条。
  const cutoff = f.now() - UNKNOWN_DELIVERY_GRACE_MS
  assert.deepEqual(f.repos.unresolvedOutbox('peer', 0, cutoff).map(row => row.id), ['fresh'])
})

test('bridge observations and recovered extraction jobs cannot create facts or affect; original remains intact', async t => {
  const f = fixture(); t.after(() => f.close())
  const message = raw(f, 'bridge', 'codex-bridge', '谢谢你，我喜欢蓝色，以后请记住')
  const payload = { v: 1, e: [{ k: 'appreciation', to: 'self', i: 'neutral', s: 3, c: 1 }], m: [{ k: 'preference', t: '喜欢蓝色', q: '我喜欢蓝色' }] }
  await f.coordinator.observe(f.binding, message, payload)
  const background = new BackgroundQueue(f.repos, f.metrics)
  let calls = 0
  const dispose = installLocalIntegration({ on: () => () => {}, config: f.config, owner: new OwnerIdentity(f.repos, f.config),
    repos: f.repos, retriever: f.retriever, coordinator: f.coordinator, background, prompts: new PromptStore(), deviceText: '', active: () => true,
    callModel: async function* () { calls++; yield { text: `<evt>${JSON.stringify(payload)}</evt>` } } })
  t.after(dispose)
  background.enqueue('extract', { messageId: message.id }, { dedupKey: 'bridge', principalId: 'p', nowMs: f.now(), availableAtMs: f.now() })
  await background.tick(f.now())
  assert.equal(calls, 0)
  assert.equal(f.repos.counts().memories, 0)
  assert.equal(f.repos.activeAffectEvents('p').length, 0)
  assert.equal(f.repos.getRawMessage(message.id).content, message.content)
  const consolidator = new Consolidator(f.repos, f.config.background, f.updater)
  const batch = consolidator.planBatch({ conversationId: 'c', principalId: 'p', afterSeq: 0 })
  assert.equal(batch.cursor, message.seq)
  assert.deepEqual(batch.messages, [])
  const human = raw(f, 'human', 'dsh', message.content)
  const planned = consolidator.planBatch({ conversationId: 'c', principalId: 'p', afterSeq: message.seq })
  f.db.run("UPDATE raw_messages SET source_kind = 'codex-bridge' WHERE id = ?", human.id)
  const report = consolidator.applyPlan(planned, { changes: [{ kind: 'preference', subject: 'owner', predicate: 'color', object: 'blue',
    claim: '喜欢蓝色', sourceMessageIds: [human.id], quote: '我喜欢蓝色', confidence: .9, salience: .8, eventAtMs: null }] }, f.now())
  assert.equal(report.rejected.length, 1)
  assert.equal(f.repos.counts().memories, 0)
})

test('pending and sending reserve limits without triggering awaiting-reply; sent and unknown still pause across conversations', t => {
  const f = fixture({ config: { proactive: { spontaneousLimitPerDay: 20 } } }); t.after(() => f.close())
  f.repos.ensureConversation('peer', 'p', 'private', 'private:peer', f.now())
  const gates = () => checkGates({ repos: f.repos, config: f.config, conversationId: 'peer', principalId: 'p', nowMs: f.now() })
  for (const [i, status] of ['pending', 'sending', 'sent', 'unknown'].entries()) {
    f.repos.enqueueOutbox({ id: status, conversationId: 'c', turnId: null, candidateKey: status, taskId: null,
      content: '问候', contentHash: status, plannedAtMs: f.now() + 3600000 + i, expectedInboundSeq: 0 })
    f.db.run('UPDATE outbox SET status = ? WHERE id = ?', status, status)
    assert.equal(gates().blocked.includes('awaiting-reply'), i >= 2)
  }
  assert.deepEqual(f.repos.unresolvedOutbox('peer', 0).map(row => row.id), ['sent', 'unknown'])
  assert.equal(f.repos.countOutboxSince('c', 0), 4)
  f.advance(7200000); raw(f, 'reply', 'qq', '你好')
  assert.equal(f.repos.unresolvedOutbox('peer', 0).length, 0)
})

test('offline CLI restore retains newer tombstones, clears raw/derived data, rebuilds affect and FTS, and is repeatable', async t => {
  const f = fixture({ config: { companion: { id: 'fixture' } } }); t.after(() => f.close())
  const message = raw(f, 'deleted-source', 'dsh', '谢谢你，我喜欢蓝色')
  await f.coordinator.observe(f.binding, message, { v: 1, e: [{ k: 'appreciation', to: 'self', i: 'neutral', s: 3, c: 1 }],
    m: [{ k: 'preference', t: '喜欢蓝色', q: '我喜欢蓝色' }] })
  learnExplicitHabit(f.repos, f.binding, raw(f, 'habit'))
  const memoryId = f.db.get('SELECT id FROM memories').id
  f.db.run("INSERT INTO memory_fts VALUES ('orphan', 'p', 'stale', '')")
  const before = backupNow(f.db, { directory: f.directory, label: 'old', keepDays: 7 }, f.now()).file
  const deletion = deleteScope(f.db, f.repos, 'p', { kind: 'message', messageId: message.id }, f.now() + 1, 7, f.config)
  const expected = f.repos.getSnapshot('p').snapshot.relationship
  deleteScope(f.db, f.repos, 'p', { kind: 'message', messageId: 'habit' }, f.now() + 2, 7, f.config)
  f.db.close()
  const config = { ...f.config, storage: { ...f.config.storage, directory: f.directory } }
  const configFile = join(f.directory, 'config.json'); writeFileSync(configFile, JSON.stringify(config))
  for (let attempt = 0; attempt < 2; attempt++) {
    const restored = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/companionctl.mjs', import.meta.url)), 'restore', before, '--offline-confirm'], {
      env: { ...process.env, DSH_COMPANION_CONFIG: configFile }, encoding: 'utf8',
    })
    assert.equal(restored.status, 0, restored.stderr)
    assert.match(restored.stdout, /已重放 2 条删除记录/)
    const db = openDatabase(config.storage, false, config.companion.id)
    try {
      const repos = new Repositories(db)
      assert.equal(repos.getMemory(memoryId), undefined)
      assert.equal(repos.getRawMessage(message.id).content, '')
      assert.ok(repos.getRawMessage(message.id).deletedAtMs)
      assert.equal(repos.listTombstones().length, 2)
      assert.ok(repos.listTombstones().some(row => row.id === deletion.tombstoneId))
      assert.equal(repos.activeAffectEvents('p').length, 0)
      assert.equal(db.get('SELECT status FROM appraisals').status, 'retracted')
      assert.deepEqual(repos.getSnapshot('p').snapshot.relationship, expected)
      assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_id IN (?, 'orphan')", memoryId).n, 0)
      assert.deepEqual(activeHabits(repos, f.binding, Date.now()), [])
      assert.equal(db.all('PRAGMA foreign_key_check').length, 0)
    } finally { db.close() }
  }
})

test('invalid backups and conflicting owners leave the target intact', t => {
  const f = fixture({ config: { companion: { id: 'fixture' } } }); t.after(() => f.close())
  const message = raw(f, 'retained')
  const config = { ...f.config, storage: { ...f.config.storage, directory: f.directory } }
  f.repos.setSetting('owner.id', 'other-owner', f.now())
  const foreign = backupNow(f.db, { directory: f.directory, label: 'foreign', keepDays: 7 }, f.now()).file
  f.repos.setSetting('owner.id', 'current-owner', f.now())
  const invalid = join(f.directory, 'invalid.sqlite3'); writeFileSync(invalid, 'not sqlite')
  const sourceBytes = readFileSync(foreign)
  f.db.close()
  assert.throws(() => restoreBackup(config, invalid, f.now()))
  assert.throws(() => restoreBackup(config, foreign, f.now()), /owner/)
  assert.deepEqual(readFileSync(foreign), sourceBytes)
  const db = openDatabase(config.storage, false, config.companion.id)
  try { assert.equal(new Repositories(db).getRawMessage(message.id).content, message.content) } finally { db.close() }
})

test('tombstone replay cancels task selectors and clears all selectors within their principal only', t => {
  const f = fixture(); t.after(() => f.close())
  raw(f, 'gone')
  f.repos.ensurePrincipal('other-p', f.config.companion.id, 'bot', 'other', f.now())
  f.repos.ensureConversation('other-c', 'other-p', 'private', 'private:other', f.now())
  f.repos.insertRawMessage({ ...raw(f, 'template'), id: 'other-source', conversationId: 'other-c', platformMessageKey: 'other' })
  f.repos.insertTask({ id: 'task', principalId: 'p', conversationId: 'c', sourceMessageId: null, kind: 'reminder', content: '提醒',
    status: 'confirmed', dueAtMs: f.now(), timezone: 'Asia/Shanghai', expiresAtMs: null, createdAtMs: f.now() })
  f.repos.insertTombstone({ id: 'task-delete', principalId: 'p', selector: { kind: 'task', taskId: 'task' }, affectedIds: [], createdAtMs: f.now() })
  replayTombstones(f.db, f.repos, f.now(), f.config)
  assert.equal(f.db.get("SELECT status FROM tasks WHERE id = 'task'").status, 'cancelled')
  f.repos.insertTombstone({ id: 'all-delete', principalId: 'p', selector: { kind: 'all' }, affectedIds: ['other-source'], createdAtMs: f.now() })
  replayTombstones(f.db, f.repos, f.now(), f.config)
  assert.equal(f.repos.getRawMessage('gone').content, '')
  assert.ok(f.repos.getRawMessage('other-source').content)
})
