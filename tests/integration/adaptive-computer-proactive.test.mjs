import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture } from '../helpers/fixture.mjs'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { PersonalityProfiles } from '../../lib/storage/personality-profiles.js'
import { proactiveFrequency } from '../../lib/proactive/frequency.js'
import { checkGates, buildCandidates } from '../../lib/proactive/candidate-builder.js'
import { OutboxWorker } from '../../lib/proactive/outbox-worker.js'
import { ProactiveScheduler } from '../../lib/proactive/scheduler.js'
import { observeComputerEvent, clearComputerEvidence } from '../../lib/proactive/computer-opportunities.js'
import { computerEvidence } from '../../lib/proactive/computer-evidence.js'
import { exportPortable, readPortable } from '../../lib/storage/portable.js'

function character(f, affection = 1, liveliness = 1, grievance = 0) {
  const old = f.repos.getSnapshot('p')
  const state = old?.snapshot ?? initialSnapshot('p', 'balanced', f.config.affect.ruleVersion, f.now())
  state.relationship = { ...state.relationship, affection, grievance }
  state.personality = { ...state.personality, initiative: liveliness }
  state.revision = (old?.revision ?? 0) + 1
  f.repos.putSnapshot(state, old?.revision ?? 0)
  new PersonalityProfiles(f.repos).configure(f.config.companion.id, 'builtin', state.personality, { mix: {}, overrides: { initiative: liveliness, socialEnergy: liveliness, playfulness: liveliness }, variation: { enabled: false, maxDelta: .05, seed: null } }, f.now())
}
function event(f, id, kind = 'resource_pressure', extra = {}) {
  return { id, kind, occurredAtMs: f.now(), summary: '系统资源紧张', details: { memoryPercent: 95 }, ...extra }
}
function enqueue(f, id, at = f.now()) {
  f.repos.enqueueOutbox({ id, conversationId: 'c', turnId: null, candidateKey: id, taskId: null, content: '自然聊一句', contentHash: id, plannedAtMs: at, expectedInboundSeq: null })
}
const gate = f => checkGates({ config: f.config, repos: f.repos, principalId: 'p', conversationId: 'c', nowMs: f.now() })

test('frequency increases only with affection AND a lively current persona, and stays within configured bounds', t => {
  const f = fixture()
  t.after(() => f.close())
  character(f, 1, 1)
  assert.deepEqual([proactiveFrequency(f.config, f.repos, 'p').dailyLimit, proactiveFrequency(f.config, f.repos, 'p').minGapMinutes], [4, 90])
  for (const [affection, lively, grievance] of [[.4, 1, 0], [1, .4, 0], [1, 1, 1]]) {
    character(f, affection, lively, grievance)
    const frequency = proactiveFrequency(f.config, f.repos, 'p')
    assert.equal(frequency.dailyLimit, 2)
    assert.equal(frequency.minGapMinutes, 180)
  }
  character(f, 1, 1)
  const disabled = { ...f.config, proactive: { ...f.config.proactive, adaptiveFrequency: false } }
  assert.equal(proactiveFrequency(disabled, f.repos, 'p').dailyLimit, 2)
  assert.equal(proactiveFrequency({ ...f.config, proactive: { ...f.config.proactive, spontaneousLimitPerDay: 0 } }, f.repos, 'p').dailyLimit, 0)
  f.repos.ensurePrincipal('other', f.config.companion.id, 'bot', 'other', f.now())
  assert.equal(proactiveFrequency(f.config, f.repos, 'other').dailyLimit, 2, 'affection never carries over to another role')
})

test('adaptive budget is applied both at candidate selection and immediately before delivery', async t => {
  const f = fixture({ config: { proactive: { enabled: true, spontaneousMinGapMinutes: 0, pauseAfterUnanswered: 5 } } })
  t.after(() => f.close())
  character(f)
  for (let n = 0; n < 2; n++) { enqueue(f, `old-${n}`, f.now() - 120 * 60000); f.repos.finishOutbox(`old-${n}`, { kind: 'accepted', atMs: f.now() - 120 * 60000 }) }
  assert.equal(gate(f).blocked.includes('daily-limit'), false)
  let sent = 0
  const worker = new OutboxWorker({ config: f.config, repos: f.repos, metrics: f.metrics, chatForConversation: () => 'private:123', transport: { sendText: async () => ({ kind: 'accepted', atMs: f.now(), platformMessageId: `new-${++sent}` }) } })
  for (let n = 0; n < 3; n++) enqueue(f, `draft-${n}`)
  const outcomes = await worker.runOnce(f.now())
  assert.equal(sent, 2)
  assert.equal(outcomes[2].reason, 'global-daily-limit')
  assert.ok(gate(f).blocked.includes('daily-limit'))
})

test('high affection cannot bypass no reply pause, busy intent, quiet hours or main conversation', async t => {
  const f = fixture({ config: { proactive: { enabled: true } } })
  t.after(() => f.close())
  character(f)
  enqueue(f, 'unanswered', f.now() - 4 * 3600000)
  f.repos.finishOutbox('unanswered', { kind: 'accepted', atMs: f.now() - 4 * 3600000 })
  assert.ok(gate(f).blocked.includes('awaiting-reply'))
  f.repos.setSetting('proactive.snooze-until:p', String(f.now() + 3600000), f.now())
  assert.ok(gate(f).blocked.includes('user-busy'))
  assert.ok(checkGates({ config: f.config, repos: f.repos, principalId: 'p', conversationId: 'c', nowMs: Date.parse('2026-10-23T16:00:00Z'), mainTurnInFlight: true }).blocked.includes('quiet-hours'))
  enqueue(f, 'pending')
  let sends = 0
  const outcomes = await new OutboxWorker({ config: f.config, repos: f.repos, metrics: f.metrics, chatForConversation: () => 'private:123', targetBusy: () => true, transport: { sendText: async () => { sends++; throw Error('must not send') } } }).runOnce(f.now())
  assert.equal(sends, 0)
  assert.equal(outcomes[0].reason, 'main-turn-in-flight')
})

test('computer observations become scoped, expiring candidates without inventing user messages or transferable evidence', t => {
  const f = fixture({ config: { proactive: { enabled: true }, computerEvents: { enabled: true } } })
  t.after(() => f.close())
  observeComputerEvent(f.repos, f.config, event(f, 'actual-event'), [f.binding])
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM raw_messages').n, 0)
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memories').n, 0)
  assert.ok(computerEvidence(f.repos, 'computer:actual-event', 'p', 'c', f.now()))
  assert.equal(computerEvidence(f.repos, 'computer:actual-event', 'other', 'c', f.now()), null)
  assert.equal(computerEvidence(f.repos, 'computer:actual-event', 'p', 'other', f.now()), null)
  assert.equal(computerEvidence(f.repos, 'computer:actual-event', 'p', 'c', f.now() + 3600000), null)
  f.advance(31000)
  const built = buildCandidates({ config: f.config, repos: f.repos, principalId: 'p', conversationId: 'c', nowMs: f.now() })
  assert.equal(built.selected?.kind, 'computer_event')
  assert.match(built.selected.topic, /不把电脑状态推断成用户情绪/)
  const path = join(f.directory, 'portable.json')
  f.repos.setSetting('owner.id', 'test-owner', f.now())
  exportPortable(f.db, f.config, path, { includePlugin: false })
  const payload = readPortable(path).payload
  assert.ok(!JSON.stringify(payload).includes('computer:actual-event'))
  enqueue(f, 'computer-draft')
  f.db.run("UPDATE outbox SET opportunity_id = ? WHERE id = 'computer-draft'", built.selected.key)
  clearComputerEvidence(f.repos)
  assert.equal(f.repos.outboxStatus('computer-draft'), 'cancelled')
  assert.equal(computerEvidence(f.repos, 'computer:actual-event', 'p', 'c', f.now()), null)
})

test('unrelated app/file changes stay quiet; configured companion interests can create a topic without attributing them to the user', t => {
  const f = fixture({ config: { computerEvents: { enabled: true }, proactive: { modelInterests: ['Blender'] } } })
  t.after(() => f.close())
  observeComputerEvent(f.repos, f.config, event(f, 'unrelated', 'foreground_app_changed', { summary: '切换到记事本', details: { current: 'notepad' } }), [f.binding])
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM proactive_opportunities').n, 0)
  observeComputerEvent(f.repos, f.config, event(f, 'related', 'foreground_app_changed', { summary: '切换到 Blender', details: { current: 'blender' } }), [f.binding])
  assert.match(f.db.get('SELECT summary FROM proactive_opportunities').summary, /不能据此声称用户也喜欢/)
  observeComputerEvent(f.repos, { ...f.config, computerEvents: { ...f.config.computerEvents, enabled: false } }, event(f, 'disabled'), [f.binding])
  observeComputerEvent(f.repos, f.config, event(f, 'group'), [{ ...f.binding, visibility: 'group' }])
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM proactive_opportunities').n, 1)
})

test('computer event passes the real scheduler and outbox, and revoking collection between generation and delivery cancels it', async t => {
  const f = fixture({ config: { proactive: { enabled: true }, computerEvents: { enabled: true } } })
  t.after(() => f.close())
  const config = structuredClone(f.config)
  let generations = 0, sends = 0
  const scheduler = new ProactiveScheduler({ config, repos: f.repos, metrics: f.metrics, listConversations: () => [{ conversationId: 'c', principalId: 'p', grievance: 0, affection: .5, unresolvedConflict: false }],
    generate: async ({ candidate }) => { generations++; assert.equal(candidate.kind, 'computer_event'); assert.match(candidate.topic, /本机实际观察/); return '电脑看起来有点忙，要不要歇一小会儿？' } })
  const worker = new OutboxWorker({ config, repos: f.repos, metrics: f.metrics, chatForConversation: () => 'desktop:c', transport: { sendText: async () => ({ kind: 'accepted', atMs: f.now(), platformMessageId: `event-${++sends}` }) } })
  observeComputerEvent(f.repos, config, event(f, 'first'), [f.binding]); f.advance(31000)
  assert.equal((await scheduler.scan(f.now())).enqueued, 1)
  config.computerEvents.enabled = false
  assert.equal((await worker.runOnce(f.now()))[0].reason, 'computer-events-disabled')
  assert.equal(sends, 0)
  config.computerEvents.enabled = true
  observeComputerEvent(f.repos, config, event(f, 'second'), [f.binding]); f.advance(31000)
  assert.equal((await scheduler.scan(f.now())).enqueued, 1)
  assert.equal((await worker.runOnce(f.now()))[0].status, 'sent')
  assert.equal(generations, 2)
  assert.equal(sends, 1)
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM raw_messages WHERE role = 'user'").n, 0)
})
