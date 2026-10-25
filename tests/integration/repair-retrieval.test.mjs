import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, insult } from '../helpers/fixture.mjs'
import { deleteScope } from '../../lib/storage/deletion.js'
test('A21: emotional episode retrieval includes evidenced later repair without rewriting the original fact', async () => {
  const f = fixture({ events: [insult, { k: 'apology', to: 'self', i: 'repair', s: 3, c: .99 }] })
  try {
    await f.turn('那次争执我直接骂了你')
    const source = f.db.get("SELECT id FROM raw_messages WHERE role = 'user' ORDER BY seq LIMIT 1").id
    const claim = '那次争执里对方直接骂了角色'
    const written = f.updater.write({ id: 'episode-memory', principalId: 'p', conversationId: 'c', visibility: 'private', kind: 'episode', subject: null, predicate: null, object: null, claim, sourceKind: 'consolidation', confidence: .9, salience: .9, eventAtMs: f.now(), observedAtMs: f.now(), evidence: [{ messageId: source, quote: '那次争执我直接骂了你' }] })
    assert.notEqual(written.type, 'rejected')
    f.advance(1000)
    await f.turn('刚才那句我说重了，对不起')
    const result = f.retriever.retrieve({ binding: f.binding, query: '那次争执', emotionArousal: 1, nowMs: f.now() })
    const memory = result.selected.find(item => item.row.id === 'episode-memory')
    assert.ok(memory)
    assert.match(memory.item.claim, /对不起/)
    assert.equal(f.repos.getMemory('episode-memory').claim, claim)
  } finally { f.close() }
})
test('A22: deleting real coordinator evidence removes its affect projection even without an appraisals-table row', async () => {
  const f = fixture({ events: [insult] })
  try {
    await f.turn('我就是在骂你')
    const source = f.db.get("SELECT id FROM raw_messages WHERE role = 'user' ORDER BY seq LIMIT 1").id
    assert.ok(f.snapshot().relationship.grievance > 0)
    // Simulate a pre-repair database whose coordinator did not persist appraisals.
    f.db.run('UPDATE affect_events SET appraisal_id = NULL')
    f.db.run('DELETE FROM appraisals')
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM appraisals').n, 0)
    const deleted = deleteScope(f.db, f.repos, 'p', { kind: 'message', messageId: source }, f.now(), 7, f.config)
    assert.equal(deleted.retractedAffectEvents, 1)
    assert.equal(f.snapshot().relationship.grievance, 0)
    assert.equal(f.repos.getRawMessage(source).content, '')
    assert.equal(f.repos.activeAffectEvents('p').length, 0)
  } finally { f.close() }
})
test('A22: forgotten memory cannot be re-extracted under a different id, while unrelated facts in the source remain usable', async () => {
  const f = fixture({ callModel: async function* () { yield { text: '<say>知道了。</say><evt>{"v":1,"e":[],"m":[{"k":"preference","t":"用户喜欢蓝色","q":"喜欢蓝色"}]}</evt>' } } })
  try {
    await f.turn('我喜欢蓝色，也喜欢绿色')
    const memory = f.repos.activeMemories('p', ['preference'], 1)[0]
    const source = f.db.get("SELECT id FROM raw_messages WHERE role = 'user' ORDER BY seq LIMIT 1").id
    deleteScope(f.db, f.repos, 'p', { kind: 'memory', memoryId: memory.id }, f.now(), 7, f.config)
    const candidate = { id: 'new-id', principalId: 'p', conversationId: 'c', visibility: 'private', kind: 'preference', subject: null, predicate: null, object: { text: '用户喜欢蓝色' }, claim: '用户喜欢蓝色', sourceKind: 'consolidation', confidence: .8, salience: .5, eventAtMs: f.now(), observedAtMs: f.now(), evidence: [{ messageId: source, quote: '喜欢蓝色' }] }
    assert.equal(f.updater.write(candidate).type, 'rejected')
    assert.equal(f.updater.write({ ...candidate, id: 'unrelated', object: { text: '用户喜欢绿色' }, claim: '用户喜欢绿色', evidence: [{ messageId: source, quote: '喜欢绿色' }] }).type, 'inserted')
  } finally { f.close() }
})
