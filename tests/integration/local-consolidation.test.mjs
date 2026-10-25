import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { scheduleConsolidation } from '../../lib/runtime/consolidation-scheduler.js'
import { Consolidator, validateChange } from '../../lib/memory/consolidator.js'
import { matchSourceQuote } from '../../lib/memory/quote-match.js'

test('quote matching returns original typography and rejects changed negatives, numbers and invented quotes', () => {
  const source = '我住在杭州，喜欢“冰美式”，价格是１.５元。'
  assert.equal(matchSourceQuote(source, '我住在杭州, 喜欢"冰美式"'), '我住在杭州，喜欢“冰美式”')
  assert.equal(matchSourceQuote(source, '价格是1.5元'), '价格是１.５元')
  assert.equal(matchSourceQuote(source, '价格是15元'), null)
  assert.equal(matchSourceQuote('我不喜欢冰美式', '我喜欢冰美式'), null)
  assert.equal(matchSourceQuote(source, '我住在上海'), null)
  assert.equal(matchSourceQuote(source, '，'), null)
  assert.equal(matchSourceQuote('code is AB CD', 'code is ABCD'), null)
  assert.equal(matchSourceQuote('code is AB   CD', 'code is AB CD'), 'code is AB   CD')
})

test('local user messages trigger consolidation without turns; dedup, restart, cursor and role isolation hold', () => {
  const f = fixture({ config: { background: { consolidateEveryTurns: 2 } } })
  const owner = new OwnerIdentity(f.repos, f.config), background = new BackgroundQueue(f.repos, f.metrics)
  const listeners = new Map()
  const install = () => installLocalIntegration({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    config: f.config, owner, repos: f.repos, retriever: f.retriever, background, coordinator: f.coordinator,
    prompts: new PromptStore(), deviceText: '', active: () => true, callModel: async function* () { yield { text: '<evt>{"v":1,"e":[]}</evt>' } },
  })
  let dispose = install()
  const emit = (id, kind = 'user', sessionId = 'local') => listeners.get('session/event')({ id: sessionId }, {
    type: 'user/message', surfaceOp: 'append', seq: 1, time: f.now(), data: { id, source: { kind }, content: [{ type: 'text', text: '我住在杭州，平时喜欢喝冰美式' }] },
  })
  const jobs = () => f.db.all("SELECT * FROM background_jobs WHERE kind = 'consolidate'")
  try {
    emit('first'); emit('first'); emit('internal', 'runtime-context')
    assert.equal(jobs().length, 0)
    emit('second')
    assert.equal(f.repos.counts().turns, 0)
    assert.equal(jobs().length, 1)
    emit('third')
    assert.equal(jobs().length, 1, 'coalesce while a job is pending')
    dispose(); dispose = install()
    assert.equal(jobs().length, 1, 'restart does not duplicate the pending job')
    const binding = owner.binding('dsh', 'local')
    const seq = f.repos.latestInboundSeq(binding.conversationId)
    f.repos.setSetting(`consolidation.cursor:${binding.conversationId}`, String(seq - 1), f.now())
    assert.equal(scheduleConsolidation(f.repos, f.config, background, binding.conversationId, binding.principalId, f.now(), { throughSeq: seq, excludeJobId: jobs()[0].id }), true, 'budget remainder continues below the normal threshold')
    for (const job of jobs()) f.repos.finishJob(job.id, 'done')
    f.repos.setSetting(`consolidation.cursor:${binding.conversationId}`, String(seq), f.now())
    assert.equal(scheduleConsolidation(f.repos, f.config, background, binding.conversationId, binding.principalId, f.now()), false)
    emit('other', 'user', 'other')
    assert.equal(jobs().length, 2, 'another conversation cannot consume this threshold')
  } finally { dispose(); f.close() }
})

test('startup schedules eligible historical local conversations and extraction stores original evidence', async () => {
  const f = fixture({ config: { background: { consolidateEveryTurns: 2 } } })
  const owner = new OwnerIdentity(f.repos, f.config), binding = owner.binding('dsh', 'local')
  const background = new BackgroundQueue(f.repos, f.metrics)
  let dispose
  try {
    for (const id of ['a', 'b']) f.repos.insertRawMessage({ id, conversationId: binding.conversationId, role: 'user', platformMessageKey: id, sourceKind: 'dsh', content: '我住在杭州，喜欢“冰美式”', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
    dispose = installLocalIntegration({ on: () => () => {}, config: f.config, owner, repos: f.repos, retriever: f.retriever, background, coordinator: f.coordinator,
      prompts: new PromptStore(), deviceText: '', active: () => true, callModel: async function* () {},
    })
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM background_jobs WHERE kind = 'consolidate'").n, 1)
    await f.coordinator.observe(binding, f.repos.getRawMessage('a'), { v: 1, e: [], m: [{ k: 'preference', t: '喜欢冰美式', q: '我住在杭州, 喜欢"冰美式"' }] })
    const memory = f.db.get('SELECT id FROM memories')
    assert.equal(f.repos.memoryEvidence(memory.id)[0].quote, '我住在杭州，喜欢“冰美式”')
  } finally { dispose?.(); f.close() }
})

test('consolidation checks every cited message and rejects deleted evidence after planning', () => {
  const f = fixture()
  try {
    for (const [id, content] of [['a', '我住在杭州，喜欢“冰美式”'], ['b', '我住在上海，喜欢喝热茶']]) {
      f.repos.insertRawMessage({ id, conversationId: 'c', role: 'user', platformMessageKey: id, sourceKind: 'dsh', content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
    }
    const consolidator = new Consolidator(f.repos, f.config.background, f.updater)
    const batch = consolidator.planBatch({ conversationId: 'c', principalId: 'p', afterSeq: 0 })
    const change = { kind: 'preference', subject: 'owner', predicate: 'coffee', object: 'iced americano', claim: '喜欢冰美式', sourceMessageIds: ['a'], quote: '我住在杭州, 喜欢"冰美式"', confidence: 0.8, salience: 0.7, eventAtMs: null }
    assert.equal(validateChange({ ...change, sourceMessageIds: ['a', 'b'] }, new Map(batch.messages.map(m => [m.id, m]))), '证据片段未在来源消息中出现')
    const report = consolidator.applyPlan(batch, { changes: [change] }, f.now())
    assert.equal(report.applied, 1)
    assert.equal(f.repos.memoryEvidence(report.touchedIds[0])[0].quote, '我住在杭州，喜欢“冰美式”')
    f.db.run('UPDATE raw_messages SET deleted_at_ms = ? WHERE id = ?', f.now(), 'a')
    assert.equal(consolidator.applyPlan(batch, { changes: [change] }, f.now()).rejected.length, 1)
  } finally { f.close() }
})
