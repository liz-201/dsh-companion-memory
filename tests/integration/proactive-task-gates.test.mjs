import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { checkGates } from '../../lib/proactive/candidate-builder.js'
import { OutboxWorker } from '../../lib/proactive/outbox-worker.js'
import { DesktopDelivery } from '../../lib/adapters/desktop-delivery.js'
import { observeFeedback } from '../../lib/proactive/feedback.js'

function enqueueTask(f, id, kind = 'open_topic') {
  f.repos.insertTask({ id: `task-${id}`, principalId: 'p', conversationId: 'c', sourceMessageId: null, kind,
    content: `待续事项 ${id}`, status: 'confirmed', dueAtMs: f.now() - 1, timezone: 'Asia/Shanghai',
    expiresAtMs: f.now() + 3600000, createdAtMs: f.now() })
  f.repos.enqueueOutbox({ id, conversationId: 'c', turnId: null, candidateKey: `candidate-${id}`, taskId: `task-${id}`,
    content: `继续聊 ${id}`, contentHash: id, plannedAtMs: f.now(), expectedInboundSeq: 0 })
}

test('open topics and commitments count toward spontaneous limits and unanswered pause; reminders retain their exception', t => {
  const f = fixture({ config: { proactive: { spontaneousLimitPerDay: 1 } } })
  t.after(() => f.close())
  enqueueTask(f, 'topic')
  f.repos.finishOutbox('topic', { kind: 'accepted', atMs: f.now() })
  f.repos.setTaskStatus('task-topic', 'done')
  enqueueTask(f, 'reminder', 'reminder')
  f.repos.finishOutbox('reminder', { kind: 'accepted', atMs: f.now() })
  f.repos.setTaskStatus('task-reminder', 'done')
  assert.equal(f.repos.countOutboxSince('c', 0), 1)
  assert.deepEqual(f.repos.unresolvedOutbox('c', 0).map(row => row.id), ['topic'])
  const gates = checkGates({ config: f.config, repos: f.repos, conversationId: 'c', principalId: 'p', nowMs: f.now() })
  assert.ok(gates.blocked.includes('daily-limit'))
  assert.ok(gates.blocked.includes('global-daily-limit'))
  assert.ok(gates.blocked.includes('awaiting-reply'))
})

test('delivery rechecks task-backed spontaneous messages so a prequeued batch cannot bypass the global daily cap', async t => {
  const f = fixture({ config: { proactive: { spontaneousLimitPerDay: 1, spontaneousMinGapMinutes: 0, pauseAfterUnanswered: 5 } } })
  t.after(() => f.close())
  enqueueTask(f, 'first', 'commitment')
  enqueueTask(f, 'second')
  let sends = 0
  const worker = new OutboxWorker({ config: f.config, repos: f.repos, metrics: f.metrics, chatForConversation: () => 'private:123',
    transport: { sendText: async () => { sends++; return { kind: 'accepted', atMs: f.now(), platformMessageId: 'sent-first' } } } })
  const outcomes = await worker.runOnce(f.now())
  assert.equal(sends, 1)
  assert.equal(outcomes[1].status, 'cancelled')
  assert.equal(outcomes[1].reason, 'global-daily-limit')
})

test('pausing proactive contact cancels pending open topics while preserving confirmed reminders', t => {
  const f = fixture()
  t.after(() => f.close())
  enqueueTask(f, 'topic')
  enqueueTask(f, 'reminder', 'reminder')
  assert.equal(f.command('proactive pause').kind, 'success')
  assert.equal(f.repos.outboxStatus('topic'), 'cancelled')
  assert.equal(f.repos.outboxStatus('reminder'), 'pending')
})

test('an explicit owner request to stop contact cancels task-backed idle messages', t => {
  const f = fixture()
  t.after(() => f.close())
  enqueueTask(f, 'topic')
  const message = f.repos.insertRawMessage({ id: 'stop', conversationId: 'c', platformMessageKey: 'stop', role: 'user', sourceKind: 'dsh',
    content: '先别主动找我', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row
  observeFeedback(f.repos, { ...f.binding, principalId: 'companion:owner:one' }, message)
  assert.equal(f.repos.outboxStatus('topic'), 'cancelled')
})

test('changing desktop persona cancels old open-topic drafts while preserving reminder tasks', t => {
  const f = fixture()
  t.after(() => f.close())
  enqueueTask(f, 'topic')
  enqueueTask(f, 'reminder', 'reminder')
  f.repos.ensureConversation('other-c', 'p', 'private', 'desktop:other', f.now())
  const delivery = new DesktopDelivery(f.repos)
  const session = { id: 'desktop', append() {}, snapshotEvents: () => [] }
  delivery.register(session, f.binding, 'preset:old')
  delivery.register(session, { ...f.binding, conversationId: 'other-c' }, 'preset:new')
  assert.equal(f.repos.outboxStatus('topic'), 'cancelled')
  assert.equal(f.repos.outboxStatus('reminder'), 'pending')
})

function userMessage(f, id, content) {
  return f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh',
    content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row
}

test('busy intent delays contact even before the first proactive delivery', t => {
  const f = fixture()
  t.after(() => f.close())
  observeFeedback(f.repos, f.binding, userMessage(f, 'busy', '现在忙，稍后再聊'))
  const gates = checkGates({ config: f.config, repos: f.repos, conversationId: 'c', principalId: 'p', nowMs: f.now() })
  assert.ok(gates.blocked.includes('user-busy'))
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM proactive_feedback').n, 0, 'No delivery means there is no feedback to attribute')
})

test('quoted examples and non-owner feedback cannot globally disable proactive contact', t => {
  const f = fixture()
  t.after(() => f.close())
  enqueueTask(f, 'topic')
  f.db.run("UPDATE outbox SET opportunity_id = 'op:shared_topic:p:test' WHERE id = 'topic'")
  f.repos.finishOutbox('topic', { kind: 'accepted', atMs: f.now() })
  f.repos.setSetting('proactive.enabled', '1', f.now())
  f.repos.ensurePrincipal('companion:owner:one', f.config.companion.id, 'bot', 'owner', f.now())
  observeFeedback(f.repos, { ...f.binding, principalId: 'companion:owner:one' }, userMessage(f, 'quoted', '比如她说“别主动找我”这句台词'))
  assert.equal(f.repos.getSetting('proactive.enabled'), '1')
  observeFeedback(f.repos, { ...f.binding, conversationKind: 'group', visibility: 'group' }, userMessage(f, 'group-user', '别主动找我'))
  assert.equal(f.repos.getSetting('proactive.enabled'), '1')
})
