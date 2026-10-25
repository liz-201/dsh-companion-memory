import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { learnExplicitHabit, activeHabits, revokeDerivedSources } from '../../lib/memory/habit-learning.js'
import { observeOpportunity, addOpportunity } from '../../lib/proactive/opportunity.js'
import { observeFeedback, feedbackAcceptance, topicAcceptance } from '../../lib/proactive/feedback.js'
import { buildCandidates, checkGates } from '../../lib/proactive/candidate-builder.js'
import { ProactiveScheduler } from '../../lib/proactive/scheduler.js'
import { OutboxWorker } from '../../lib/proactive/outbox-worker.js'
import { Consolidator } from '../../lib/memory/consolidator.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'

function raw(f, id, content) {
  return f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh', content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row
}
const gateInput = f => ({ repos: f.repos, config: f.config, conversationId: 'c', principalId: 'p', nowMs: f.now() })

test('A09 / A10 / A11 / A22: explicit habits persist, examples and temporary requests do not, source deletion revokes', () => {
  const f = fixture()
  try {
    for (const [id, text] of [['example', '比如她以后叫我主人'], ['temp', '这次用表格，以后再说'], ['real', '以后不要叫我主人']]) learnExplicitHabit(f.repos, f.binding, raw(f, id, text))
    assert.deepEqual(activeHabits(f.repos, f.binding, f.now()).map(x => x.value), ['主人'])
    revokeDerivedSources(f.repos, ['real'])
    assert.equal(activeHabits(f.repos, f.binding, f.now()).length, 0)
  } finally { f.close() }
})

test('A23 / A24: no candidate creates no calls; sourced follow-up respects quiet hours and device ownership', async () => {
  const f = fixture()
  try {
    let calls = 0
    const scheduler = new ProactiveScheduler({ config: f.config, repos: f.repos, metrics: f.metrics, listConversations: () => [{ conversationId: 'c', principalId: 'p' }], generate: async () => { calls++; return '后来怎么样？' } })
    for (let i = 0; i < 100; i++) await scheduler.scan(f.now())
    assert.equal(calls, 0)
    observeOpportunity(f.repos, f.binding, raw(f, 'source', '我今天去面试'))
    f.advance(3 * 3600000 + 1)
    assert.equal(buildCandidates(gateInput(f)).selected.kind, 'follow_up')
    f.db.run('INSERT INTO proactive_ownership VALUES (?, ?, ?, ?, NULL)', f.config.companion.id, 'other-device', 'r', '[]')
    assert.ok(checkGates(gateInput(f)).blocked.includes('inactive-device'))
  } finally { f.close() }
})

test('A25 / A30: delivery and silence never silently resume contact after seven days or award affect', async () => {
  const f = fixture()
  try {
    const message = raw(f, 'source', '我通过了考试')
    const opportunity = addOpportunity(f.repos, { binding: f.binding, kind: 'positive_revisit', summary: '问考试后的安排', sourceIds: [message.id], nowMs: f.now(), notBeforeMs: f.now(), expiresAtMs: f.now() + 86400000 })
    const scheduler = new ProactiveScheduler({ config: f.config, repos: f.repos, metrics: f.metrics, listConversations: () => [{ conversationId: 'c', principalId: 'p' }], generate: async () => '考试之后有什么安排？' })
    assert.equal((await scheduler.scan(f.now())).enqueued, 1)
    const sends = []
    const worker = new OutboxWorker({ config: f.config, repos: f.repos, metrics: f.metrics, transport: { sendText: async (_, text) => { sends.push(text); return { kind: 'accepted', atMs: f.now(), platformMessageId: 'sent' } } }, chatForConversation: () => 'private:123', now: f.now })
    assert.equal((await worker.runOnce(f.now()))[0].status, 'sent')
    assert.equal(f.db.get('SELECT status FROM proactive_opportunities WHERE id = ?', opportunity).status, 'sent')
    const before = f.snapshot()
    f.advance(8 * 86400000)
    assert.ok(checkGates(gateInput(f)).blocked.includes('awaiting-reply'))
    assert.deepEqual(f.snapshot(), before)
    const busy = raw(f, 'busy', '现在忙，稍后再聊')
    observeFeedback(f.repos, f.binding, busy)
    assert.equal(f.repos.activeAffectEvents('p').length, 0)
    assert.equal(sends.length, 1)
    assert.equal(feedbackAcceptance(Array.from({ length: 8 }, () => ({ kind: 'unknown' }))), .5)
  } finally { f.close() }
})

test('A26 / A27: explicit reply feedback is idempotent, affects acceptance, and busy delays contact without penalizing affection', () => {
  const f = fixture()
  try {
    for (let i = 0; i < 6; i++) {
      const id = `feedback-out-${i}`, opportunity = `op:interest_share:p:${i}`
      f.repos.enqueueOutbox({ id, conversationId: 'c', turnId: null, candidateKey: opportunity, taskId: null, content: '分享一篇相关内容', contentHash: id, plannedAtMs: f.now(), expectedInboundSeq: f.repos.latestInboundSeq('c') })
      f.db.run('UPDATE outbox SET opportunity_id = ? WHERE id = ?', opportunity, id)
      f.repos.finishOutbox(id, { kind: 'accepted', atMs: f.now(), platformMessageId: id })
      f.advance(1000)
      const reply = raw(f, `positive-${i}`, '这个分享很有意思')
      observeFeedback(f.repos, f.binding, reply); observeFeedback(f.repos, f.binding, reply)
    }
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM proactive_feedback').n, 6)
    assert.ok(topicAcceptance(f.repos, 'p', 'interest_share', f.now(), f.config.proactive.timezone) > .5)
    observeFeedback(f.repos, f.binding, raw(f, 'busy-now', '现在忙，稍后再聊'))
    assert.ok(checkGates(gateInput(f)).blocked.includes('user-busy'))
    assert.equal(f.repos.activeAffectEvents('p').length, 0)
  } finally { f.close() }
})

test('A20: oversized original is processed by bounded fragments without skipping its tail', () => {
  const f = fixture({ config: { background: { inputLimitTokens: 128 } } })
  try {
    const message = raw(f, 'large', '我喜欢蓝色，'.repeat(150) + '我住在杭州。')
    const consolidator = new Consolidator(f.repos, f.config.background, f.updater)
    let cursor = 0, joined = '', batches = 0
    while (cursor < message.seq && batches++ < 100) {
      const batch = consolidator.planBatch({ conversationId: 'c', principalId: 'p', afterSeq: cursor })
      assert.ok(batch.estimatedTokens <= 128)
      joined += batch.messages.map(x => x.content).join('')
      cursor = consolidator.applyPlan(batch, { changes: [] }, f.now()).nextCursor
    }
    assert.equal(joined, message.content)
    assert.equal(cursor, message.seq)
    assert.ok(batches > 1)
  } finally { f.close() }
})

test('background retry is bounded and preserves the original job identity', async () => {
  const f = fixture()
  try {
    const queue = new BackgroundQueue(f.repos, f.metrics, { maxRetries: 2 })
    let attempts = 0
    queue.register('extract', () => { attempts++; throw new Error('offline') })
    queue.enqueue('extract', {}, { dedupKey: 'retry', principalId: 'p', nowMs: f.now(), availableAtMs: f.now() })
    for (let i = 0; i < 4; i++) await queue.tick(f.now() + i * 10000)
    assert.equal(attempts, 3)
    assert.equal(f.db.get('SELECT status FROM background_jobs').status, 'failed')
  } finally { f.close() }
})
