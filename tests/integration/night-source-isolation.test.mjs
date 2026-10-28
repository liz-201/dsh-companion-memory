import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { scheduleConsolidation } from '../../lib/runtime/consolidation-scheduler.js'
import { Consolidator } from '../../lib/memory/consolidator.js'
import { activeHabits, learnExplicitHabit } from '../../lib/memory/habit-learning.js'
import { observeFeedback } from '../../lib/proactive/feedback.js'
import { observeOpportunity } from '../../lib/proactive/opportunity.js'
import { continuousAffect, saveEmotionAppraisals } from '../../lib/storage/continuous-affect.js'

const bridge = (body, id = 'night-isolation') => `[Codex 协作回复 / mailbox ${id}]\n${body}`

// Only temporary databases and a fake host. No native DSH connection, files or model provider.
function localHost(t, config = {}) {
  const f = fixture({ config: { background: { consolidateEveryTurns: 2 }, ...config } })
  t.mock.method(Date, 'now', f.now)
  const owner = new OwnerIdentity(f.repos, f.config)
  const session = { id: 'night-isolation-local' }
  const binding = owner.binding('dsh', session.id, owner.deviceId, f.now())
  const background = new BackgroundQueue(f.repos, f.metrics, { now: f.now, batch: 20 })
  const listeners = new Map(), requests = [], targets = [], queries = []
  let runtimeText, dispose, sequence = 0
  const install = () => installLocalIntegration({
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    config: f.config, owner, repos: f.repos,
    retriever: { retrieve: request => { queries.push(request.query); return f.retriever.retrieve(request) } },
    background, coordinator: f.coordinator, prompts: new PromptStore(), deviceText: '', active: () => true,
    runtimeContext: fn => { runtimeText = fn; return () => { runtimeText = undefined } },
    localTarget: (...args) => targets.push(args),
    callModel: async function* (request) {
      requests.push(request)
      yield { text: '<observation>{"v":2,"legacy":{"v":1,"e":[]},"appraisals":[]}</observation>' }
    },
  })
  dispose = install()
  const emit = (id, text, kind = 'user') => listeners.get('session/event')(session, {
    type: 'user/message', surfaceOp: 'append', seq: ++sequence, time: f.now(),
    data: { id, source: { kind }, content: [{ type: 'text', text }] },
  })
  const raw = id => f.repos.getRawMessage(`${binding.conversationId}:${id}`)
  const jobs = kind => f.db.all('SELECT * FROM background_jobs WHERE kind = ? ORDER BY id', kind)
  return {
    ...f, owner, session, binding, background, listeners, requests, coordinatorRequests: f.requests, targets, queries, emit, raw, jobs,
    context: () => runtimeText({ agent: { id: 'night-isolation-agent', session } }),
    reinstall: () => { dispose(); dispose = install() },
    close: () => { dispose(); background.stop(); f.close() },
  }
}

test('real session/event stores bridge ingress without owner learning, proactive feedback or response settlement', t => {
  const h = localHost(t)
  try {
    h.repos.setSetting('proactive.enabled', '1', h.now())
    h.emit('bridge-feedback', bridge('先别主动找我，现在我在检查协作消息的来源隔离。', 'source-feedback'))
    h.emit('bridge-opportunity', ` \t\n${bridge('明天面试，我需要你继续核对插件而不是安排后续关心。', 'source-opportunity')}`)
    h.emit('bridge-habit', `\u00a0${bridge('以后别叫我小可爱；这里是桥接测试素材。', 'source-habit')}`)

    const rows = h.repos.rawMessagesAfter(h.binding.conversationId, 0, 20)
    assert.equal(rows.length, 3, 'technical messages remain inspectable as raw history')
    assert.ok(rows.every(row => row.role === 'user' && row.sourceKind === 'codex-bridge'))
    assert.equal(h.repos.getSetting('proactive.enabled'), '1', 'bridge preference cannot disable proactive behavior')
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM proactive_opportunities').n, 0)
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM proactive_feedback').n, 0)
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM expression_habits').n, 0)
    assert.equal(h.jobs('extract').length, 0)
    assert.equal(h.jobs('consolidate').length, 0)
    assert.equal(h.db.get('SELECT latest_inbound_seq AS n FROM conversations WHERE id = ?', h.binding.conversationId).n, 0)
    assert.equal(h.repos.latestInboundSeq(h.binding.conversationId), 0, 'read paths must not count a bridge append as owner input')
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM response_events WHERE principal_id = ?', h.binding.principalId).n, 0)
    assert.equal(continuousAffect(h.repos, h.config, h.binding.principalId, h.now()).drives.responses, 0)
    assert.equal(h.targets.length, 0, 'bridge history cannot become a local proactive delivery target')
  } finally { h.close() }
})

test('real human ingress still changes explicit preferences, creates sourced opportunities and runs extraction once', async t => {
  const h = localHost(t)
  try {
    h.repos.setSetting('proactive.enabled', '1', h.now())
    h.emit('human-feedback', '先别主动找我，现在我正在认真处理一些事情，之后再恢复。')
    assert.equal(h.repos.getSetting('proactive.enabled'), '0')
    h.repos.setSetting('proactive.enabled', '1', h.now())
    h.emit('human-opportunity', '明天面试，我住在杭州，平时喜欢喝冰美式，面试以后再告诉你结果。')
    h.emit('human-habit', '以后别叫我小可爱，闲聊时就直接接我的具体话题，不要每次换称呼。')
    h.emit('human-habit', '以后别叫我小可爱，闲聊时就直接接我的具体话题，不要每次换称呼。')

    const messages = h.repos.rawMessagesAfter(h.binding.conversationId, 0, 20)
    assert.equal(messages.length, 3, 'duplicate host append is idempotent')
    assert.ok(messages.every(row => row.sourceKind === 'dsh'))
    assert.equal(h.jobs('extract').length, 3)
    assert.equal(h.jobs('consolidate').length, 1)
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM proactive_opportunities').n, 1)
    const opportunity = h.db.get('SELECT source_ids_json FROM proactive_opportunities')
    assert.deepEqual(JSON.parse(opportunity.source_ids_json), [h.raw('human-opportunity').id])
    assert.ok(activeHabits(h.repos, h.binding, h.now()).some(row => row.kind === 'address_block' && row.value === '小可爱'))
    assert.equal(h.repos.latestInboundSeq(h.binding.conversationId), h.raw('human-habit').seq)
    assert.equal(continuousAffect(h.repos, h.config, h.binding.principalId, h.now()).drives.responses, 3, 'same timestamp does not merge distinct owner messages')
    const batch = new Consolidator(h.repos, h.config.background, h.updater).planBatch({
      conversationId: h.binding.conversationId, principalId: h.binding.principalId, afterSeq: 0,
    })
    assert.ok(batch.messages.some(row => row.id === h.raw('human-opportunity').id))

    h.advance(1500)
    await h.background.tick(h.now())
    assert.equal(h.requests.length, 3)
    assert.ok(h.jobs('extract').every(row => row.status === 'done' && row.attempts === 1))
    assert.equal(continuousAffect(h.repos, h.config, h.binding.principalId, h.now()).drives.responses, 3)
  } finally { h.close() }
})

test('short bridge replies cannot supply the three human examples needed for an implicit habit', t => {
  const h = localHost(t)
  try {
    h.emit('short-bridge-a', bridge('好', 'a'))
    h.emit('short-bridge-b', bridge('行', 'b'))
    h.emit('short-human-a', '早上好')
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM expression_habits WHERE kind='implicit_verbosity'").n, 0)
    h.emit('short-human-b', '今天可以')
    h.emit('short-human-c', '晚点见')
    const habit = h.db.get("SELECT source_ids_json FROM expression_habits WHERE kind='implicit_verbosity'")
    assert.ok(habit, 'three actual human messages still support a proposed habit')
    assert.deepEqual(new Set(JSON.parse(habit.source_ids_json)), new Set(['short-human-a', 'short-human-b', 'short-human-c'].map(id => h.raw(id).id)))
  } finally { h.close() }
})

test('historical dsh-labelled bridge rows are excluded on extraction, consolidation, habit and continuous-state reads', async t => {
  const h = localHost(t)
  try {
    const insertOldHuman = (id, content) => h.repos.insertRawMessage({
      id, conversationId: h.binding.conversationId, platformMessageKey: id, role: 'user', sourceKind: 'dsh', content,
      occurredAtMs: h.now(), observedAtMs: h.now(), deliveryStatus: null, deletedAtMs: null,
    }).row
    const first = insertOldHuman('historical-bridge-a', '明天面试，我住在杭州，平时喜欢喝冰美式，先别主动找我。')
    const second = insertOldHuman('historical-bridge-b', '以后别叫我小可爱，我需要你保持之前说过的称呼边界。')
    learnExplicitHabit(h.repos, h.binding, second)
    saveEmotionAppraisals(h.repos, h.binding, first, [{
      focus: 'event', affectedParty: 'self', desirability: -.8,
      quote: '明天面试', confidence: .95, relevance: .9,
    }])
    for (const [message, whitespace] of [[first, ''], [second, '\u00a0']]) {
      h.db.run("UPDATE raw_messages SET content = ?, source_kind = 'dsh' WHERE id = ?", whitespace + bridge(message.content, message.id), message.id)
    }
    // Emulate old persisted state that predates the new read gate. No production DB is involved.
    h.db.run("UPDATE emotion_appraisals SET status='active' WHERE source_message_id=?", first.id)
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM response_events WHERE principal_id=?', h.binding.principalId).n, 2)
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM emotion_appraisals WHERE status='active'").n, 1)
    assert.equal(h.repos.getRawMessage(first.id).sourceKind, 'dsh')
    h.reinstall()

    assert.equal(h.jobs('consolidate').length, 0, 'restart cannot schedule a bridge-only historical batch')
    assert.equal(scheduleConsolidation(h.repos, h.config, h.background, h.binding.conversationId, h.binding.principalId, h.now()), false)
    const consolidator = new Consolidator(h.repos, h.config.background, h.updater)
    const batch = consolidator.planBatch({ conversationId: h.binding.conversationId, principalId: h.binding.principalId, afterSeq: 0 })
    assert.equal(batch.messages.length, 0)
    assert.equal(batch.cursor, second.seq, 'skipped technical history still advances the scan cursor')
    assert.deepEqual(activeHabits(h.repos, h.binding, h.now()), [])
    assert.equal(h.repos.latestInboundSeq(h.binding.conversationId), 0)
    const state = continuousAffect(h.repos, h.config, h.binding.principalId, h.now())
    assert.equal(state.drives.responses, 0)
    assert.equal(state.appraisalCount, 0)
    assert.deepEqual(state.evidenceIds, [])

    h.repos.setSetting('proactive.enabled', '1', h.now())
    for (const id of [first.id, second.id]) {
      const old = h.repos.getRawMessage(id)
      observeFeedback(h.repos, h.binding, old)
      observeOpportunity(h.repos, h.binding, old)
      learnExplicitHabit(h.repos, h.binding, old)
      await h.coordinator.requestObservation(h.binding, old)
      h.background.enqueue('extract', { messageId: id }, {
        dedupKey: `historical-bridge:${id}`, principalId: h.binding.principalId, availableAtMs: h.now(), nowMs: h.now(),
      })
    }
    await h.background.tick(h.now())
    assert.equal(h.requests.length, 0, 'old pending extract jobs never call the provider')
    assert.equal(h.coordinatorRequests.length, 0, 'direct observations also reject technical sources before model admission')
    assert.equal(h.repos.getSetting('proactive.enabled'), '1')
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM proactive_opportunities').n, 0)
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM memories').n, 0)
    assert.ok(h.jobs('extract').every(row => row.status === 'done'))
    assert.equal(h.repos.getSetting(`emotion.observed:${first.id}`), undefined)
  } finally { h.close() }
})

test('consolidation revalidates a source that becomes recognizable as historical bridge text after planning', t => {
  const h = localHost(t)
  try {
    const content = '我住在杭州，平时喜欢喝冰美式，之后也希望你记住这条偏好。'
    const raw = h.repos.insertRawMessage({
      id: 'planned-legacy-bridge', conversationId: h.binding.conversationId, platformMessageKey: 'planned-legacy-bridge',
      role: 'user', sourceKind: 'dsh', content, occurredAtMs: h.now(), observedAtMs: h.now(), deliveryStatus: null, deletedAtMs: null,
    }).row
    const consolidator = new Consolidator(h.repos, h.config.background, h.updater)
    const batch = consolidator.planBatch({ conversationId: h.binding.conversationId, principalId: h.binding.principalId, afterSeq: 0 })
    assert.ok(batch.messages.some(row => row.id === raw.id))
    h.db.run("UPDATE raw_messages SET content=?, source_kind='dsh' WHERE id=?", bridge(content, 'identified-late'), raw.id)
    const result = consolidator.applyPlan(batch, { changes: [{
      kind: 'preference', subject: 'owner', predicate: 'coffee', object: 'iced americano', claim: '喜欢冰美式',
      sourceMessageIds: [raw.id], quote: '我住在杭州，平时喜欢喝冰美式', confidence: .8, salience: .7, eventAtMs: null,
    }] }, h.now())
    assert.equal(result.applied, 0)
    assert.equal(result.rejected.length, 1)
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM memories').n, 0)
  } finally { h.close() }
})

test('bridge session append and inbox claim cannot replace the latest human retrieval query', t => {
  const h = localHost(t)
  try {
    const human = '我住在杭州，最近想继续讨论我们此前提到的咖啡偏好。'
    h.emit('query-human', human)
    h.context()
    assert.equal(h.queries.at(-1), human)
    const technical = bridge('先别主动找我，明天面试；这是协作诊断，不是主人查询。', 'query-bridge')
    h.emit('query-bridge', technical)
    h.listeners.get('agent/inbox/claimed')({
      agent: { id: 'night-isolation-agent', session: h.session },
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: technical }] },
    })
    h.context()
    assert.equal(h.queries.at(-1), human)
  } finally { h.close() }
})
