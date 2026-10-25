import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { parseConsolidationOutput, requestConsolidationPlan } from '../../lib/memory/consolidation-output.js'
import { Consolidator } from '../../lib/memory/consolidator.js'
import { recoverConsolidationJobs } from '../../lib/runtime/consolidation-scheduler.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { apply } from '../../lib/index.js'
import { setImmediate } from 'node:timers/promises'

const change = { kind: 'fact', subject: '用户', predicate: '居住地', object: '杭州', claim: '用户住在杭州',
  sourceMessageIds: ['source'], quote: '我住在杭州', confidence: .9, salience: .5, eventAtMs: null, relation: 'supports' }
function batchFor(f) {
  f.repos.insertRawMessage({ id: 'source', conversationId: 'c', platformMessageKey: 'source', role: 'user', sourceKind: 'dsh',
    content: '我住在杭州，平时喜欢喝冰美式。', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
  return new Consolidator(f.repos, f.config.background, f.updater).planBatch({ conversationId: 'c', principalId: 'p', afterSeq: 0 })
}

test('consolidation parses objects, bare arrays and fenced values without splitting quoted braces', () => {
  for (const output of [JSON.stringify({ changes: [change] }), JSON.stringify([change]), `说明\n\`\`\`json\n{}\n\`\`\`\n\`\`\`json\n${JSON.stringify([change])}\n\`\`\``, `前缀 ${JSON.stringify({ changes: [{ ...change, claim: '字面 } 与 [ 符号' }] })} 尾注`]) {
    assert.equal(parseConsolidationOutput(output).changes.length, 1)
  }
  assert.equal(parseConsolidationOutput('{}'), null)
  assert.equal(parseConsolidationOutput('只有聊天文本'), null)
})

test('one correction retry recovers structured changes; evidence validation still rejects invented quotations', async t => {
  const f = fixture(); t.after(() => f.close())
  const batch = batchFor(f), corrections = []
  const result = await requestConsolidationPlan(batch, 0, async correction => { corrections.push(correction); return corrections.length === 1 ? '{}' : JSON.stringify([change]) })
  assert.equal(corrections.length, 2)
  assert.match(corrections[1], /上次整理结果/)
  assert.equal(result.plan.changes[0].relation, 'supports')
  const consolidator = new Consolidator(f.repos, f.config.background, f.updater)
  assert.equal(consolidator.applyPlan(batch, result.plan, f.now()).applied, 1)
  assert.equal(consolidator.applyPlan(batch, { changes: [{ ...change, quote: '我住在上海' }] }, f.now()).rejected.length, 1)
})

test('malformed output has a bounded diagnosed empty result, preserves originals, and transport errors do not advance', async t => {
  const f = fixture(); t.after(() => f.close())
  const batch = batchFor(f)
  let calls = 0
  const result = await requestConsolidationPlan(batch, 0, async () => { calls++; return '没有 JSON' })
  assert.equal(calls, 2)
  assert.equal(result.degraded, true)
  assert.deepEqual(result.plan.changes, [])
  assert.equal(result.plan.cursor, batch.cursor)
  assert.equal(result.plan.summary, null)
  assert.equal(f.repos.getRawMessage('source').content, batch.messages[0].content)
  await assert.rejects(requestConsolidationPlan(batch, 0, async () => { throw new Error('offline') }), /offline/)
})

test('a nonadvancing or future model cursor cannot keep consolidation stuck or skip unseen rows', async t => {
  const f = fixture(); t.after(() => f.close())
  const batch = batchFor(f)
  for (const cursor of [0, batch.cursor + 100, -1, .5]) {
    const result = await requestConsolidationPlan(batch, 0, async () => JSON.stringify({ changes: [], cursor }))
    assert.equal(result.degraded, true)
    assert.equal(result.plan.cursor, batch.cursor)
  }
  let attempts = 0
  const corrected = await requestConsolidationPlan({ ...batch, cursor: 3 }, 0, async () => JSON.stringify({ changes: [], cursor: ++attempts === 1 ? 0 : 1 }))
  assert.equal(corrected.plan.cursor, 1, 'A valid corrected partial cursor must remain partial')
  const partialBatch = { ...batch, cursor: 20, messages: [{ ...batch.messages[0], seq: 11 }] }
  const partial = await requestConsolidationPlan(partialBatch, 10, async () => JSON.stringify({ changes: [change], cursor: 0 }))
  assert.equal(partial.plan.cursor, 11, 'Malformed cursor must not mark the unreferenced tail processed')
})

test('oversized output is bounded, while the twenty-change limit is distinct from malformed shapes', async t => {
  const f = fixture(); t.after(() => f.close())
  const batch = batchFor(f)
  const oversized = await requestConsolidationPlan(batch, 0, async () => 'x'.repeat(131073))
  assert.deepEqual(oversized.plan.changes, [])
  assert.ok(oversized.problems.includes('output-too-large'))
  assert.equal(oversized.attempts, 2)
  let calls = 0
  const many = await requestConsolidationPlan(batch, 0, async () => { calls++; return JSON.stringify({ changes: Array.from({ length: 21 }, () => change), cursor: batch.cursor }) })
  assert.equal(calls, 1)
  assert.equal(many.plan.changes.length, 20)
  assert.ok(many.problems.includes('changes-truncated'))
  assert.ok(!many.problems.includes('invalid-change-shape'))
})

test('changes beyond a valid partial cursor wait for the next batch without skipping intervening messages', async t => {
  const f = fixture(); t.after(() => f.close())
  batchFor(f)
  for (const [id, content] of [['middle', '我平时喜欢去公园散步和看书。'], ['future', '我住在上海，平时喜欢喝热茶。']]) {
    f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh', content,
      occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
  }
  const consolidator = new Consolidator(f.repos, f.config.background, f.updater)
  const batch = consolidator.planBatch({ conversationId: 'c', principalId: 'p', afterSeq: 0 })
  const futureChange = { ...change, object: '上海', claim: '用户住在上海', quote: '我住在上海', sourceMessageIds: ['future'] }
  const firstSeq = f.repos.getRawMessage('source').seq
  const partial = await requestConsolidationPlan(batch, 0, async () => JSON.stringify({ changes: [futureChange], cursor: firstSeq, summary: '未来消息摘要' }))
  assert.deepEqual(partial.plan.changes, [])
  assert.equal(partial.plan.cursor, firstSeq)
  assert.equal(partial.plan.summary, null)
  assert.ok(partial.problems.includes('changes-beyond-cursor'))
  const applied = consolidator.applyPlan(batch, partial.plan, f.now())
  assert.equal(applied.applied, 0)
  const next = consolidator.planBatch({ conversationId: 'c', principalId: 'p', afterSeq: applied.nextCursor })
  assert.deepEqual(next.messages.map(message => message.id), ['middle', 'future'])
  const valid = await requestConsolidationPlan(next, firstSeq, async () => JSON.stringify({ changes: [futureChange], cursor: next.cursor }))
  assert.equal(consolidator.applyPlan(next, valid.plan, f.now()).applied, 1)
  assert.equal(f.repos.counts().memories, 1)
})

test('protocol upgrade requeues an old terminal failure once and finishes a real queued consolidation', async t => {
  const f = fixture(); t.after(() => f.close())
  const batch = batchFor(f)
  const queue = new BackgroundQueue(f.repos, f.metrics)
  queue.enqueue('consolidate', { conversationId: 'c' }, { dedupKey: 'old-consolidation', principalId: 'p', availableAtMs: f.now(), nowMs: f.now() })
  const jobId = f.db.get('SELECT id FROM background_jobs').id
  f.repos.finishJob(jobId, 'failed', '无效的整理输出：缺少 changes 数组；未推进游标')
  assert.equal(recoverConsolidationJobs(f.repos, f.now()), 1)
  queue.register('consolidate', async () => {
    const result = await requestConsolidationPlan(batch, 0, async () => JSON.stringify([change]))
    const applied = new Consolidator(f.repos, f.config.background, f.updater).applyPlan(batch, result.plan, f.now())
    f.repos.setSetting('consolidation.cursor:c', String(applied.nextCursor), f.now())
    f.repos.putCheckpoint({ id: 'recovered', conversationId: 'c', sessionId: 'background', summary: { topic: '' }, evidenceIds: applied.touchedIds, createdAtMs: f.now() })
  })
  await queue.tick(f.now())
  assert.equal(f.db.get('SELECT status FROM background_jobs WHERE id = ?', jobId).status, 'done')
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM topic_checkpoints').n, 1)
  assert.equal(f.repos.counts().memories, 1)
  f.repos.finishJob(jobId, 'failed', '无效的整理输出：缺少 changes 数组')
  assert.equal(recoverConsolidationJobs(f.repos, f.now()), 0, 'Restart must not reset permanent failures indefinitely')
})

test('the mounted plugin completes its actual background handler when the model returns a bare array', async t => {
  const f = fixture(); t.after(() => f.close())
  const listeners = new Map(), provided = new Map()
  let consolidationCalls = 0
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: f.now() })
  const ctx = {
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) },
    provide(name, value) { provided.set(name, value) }, emit() {}, effect() {},
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'scripted' }) },
    llm: { async *stream(request) {
      const user = request.messages.find(message => message.role === 'user')?.content.map(block => block.text ?? '').join('') ?? ''
      if (user.startsWith('消息如下：')) {
        consolidationCalls++
        const sourceId = /\[([^\]]+)\]/.exec(user)[1]
        yield { type: 'text-delta', index: 0, text: JSON.stringify([{ ...change, sourceMessageIds: [sourceId] }]) }
      } else yield { type: 'text-delta', index: 0, text: '<evt>{"v":1,"e":[]}</evt>' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  }
  let service
  try {
    apply(ctx, { storage: { directory: joinForMounted(f.directory), backupDaily: false }, background: { consolidateEveryTurns: 1 }, proactive: { enabled: false } })
    service = provided.get('companionMemory')
    listeners.get('session/event')({ id: 'mounted' }, { type: 'user/message', surfaceOp: 'append', seq: 1, time: f.now(),
      data: { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: '我住在杭州，平时喜欢喝冰美式。' }] } })
    t.mock.timers.tick(6000)
    for (let i = 0; i < 100 && service.status().background.doneTotal < 2; i++) await setImmediate()
    assert.equal(consolidationCalls, 1)
    assert.equal(service.status().background.failedTotal, 0)
    assert.ok(service.status().background.doneTotal >= 2)
    assert.equal(service.status().counts.memories, 1)
  } finally { await service?.shutdown(); t.mock.timers.reset() }
})

function joinForMounted(directory) { return `${directory}/mounted` }
