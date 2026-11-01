import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { ExpressionRuntime } from '../../lib/expression/runtime.js'
import { renderPlan } from '../../lib/expression/policy.js'
import { INTIMACY_GUIDANCE } from '../../lib/expression/intimacy-policy.js'
import { saveEmotionAppraisals } from '../../lib/storage/continuous-affect.js'
import { deleteScope } from '../../lib/storage/deletion.js'
import { readEroticPolicy, setEroticPolicy, recordIntimacyStop, readIntimacyExpression, eroticAffect } from '../../lib/storage/erotic-interest.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'

// All age assertions and conversations below are synthetic fixtures, never live settings.
const allow = { enabled: true, ownerAdultConfirmed: true, characterAdultConfirmed: true }
const invitation = '我对你有性吸引，也愿意继续这类亲密话题。'
const voice = '我也想更亲近你一些。'
const appraisal = text => ({ focus: 'object', concern: 'relationship', appealingness: .5, quote: text, confidence: 1,
  eroticCue: { kind: 'interest', strength: 1, quote: text.split('，')[0] } })
const observation = text => `<observation>${JSON.stringify({ v: 3, legacy: { v: 1, e: [] }, appraisals: [appraisal(text)] })}</observation>`
const state = (f, binding = f.binding) => initialSnapshot(binding.principalId, f.config.companion.preset, f.config.affect.ruleVersion, f.now())
const raw = (f, id, text = invitation, binding = f.binding, sourceKind = 'dsh') => f.repos.insertRawMessage({
  id, conversationId: binding.conversationId, role: 'user', sourceKind, platformMessageKey: id,
  content: text, occurredAtMs: f.now(), observedAtMs: f.now(), deletedAtMs: null, deliveryStatus: null,
}).row
function eligible(f, id = 'adult-invitation', binding = f.binding) {
  setEroticPolicy(f.repos, binding.principalId, allow, f.now())
  f.advance(1000)
  const source = raw(f, id, invitation, binding)
  saveEmotionAppraisals(f.repos, binding, source, [appraisal(source.content)])
  return source
}

test('natural invitations reach the real observer, persistent state and expression plan after local opt-in', async t => {
  const text='今晚想你了'
  const f=fixture({callModel:async function*(){yield {text:observation(text)}}})
  t.after(()=>f.close())
  setEroticPolicy(f.repos,'p',allow,f.now())
  f.advance(1000)
  const source=raw(f,'natural-observer',text)
  await f.coordinator.requestObservation(f.binding,source)
  assert.equal(eroticAffect(f.repos,'p',f.now()).value,.3)
  const runtime=new ExpressionRuntime(f.repos,f.config)
  assert.equal(runtime.plan(state(f),text,f.now(),f.binding).intimacyIntent.kind,'flutter')
  const source2=raw(f,'mixed-natural','想抱你，同时帮我把插件那个报错修一下')
  saveEmotionAppraisals(f.repos,f.binding,source2,[appraisal(source2.content)])
  assert.equal(eroticAffect(f.repos,'p',f.now()).value,.6)
})

test('real observation ingress omits the optional contract by default and preserves ordinary affect', async t => {
  const f = fixture({ callModel: async function* () { yield { text: observation(invitation) } } })
  t.after(() => f.close())
  const source = raw(f, 'closed-observer')
  await f.coordinator.requestObservation(f.binding, source)
  assert.equal(f.requests.length, 1)
  assert.doesNotMatch(f.requests[0].systemText, /eroticCue/)
  const saved = JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals WHERE source_message_id=?', source.id).vector_json)
  assert.equal(saved.eroticCue, undefined)
  assert.equal(saved.appealingness, .5)
  assert.equal(eroticAffect(f.repos, 'p', f.now()).value, null)

  setEroticPolicy(f.repos, 'p', allow, f.now())
  f.advance(1000)
  const enabled = raw(f, 'enabled-observer')
  await f.coordinator.requestObservation(f.binding, enabled)
  assert.match(f.requests[1].systemText, /eroticCue/)
  assert.equal(eroticAffect(f.repos, 'p', f.now()).value, .3)
})

test('a policy change during model observation strips the cue without discarding ordinary appraisal', async t => {
  const f = fixture()
  t.after(() => f.close())
  setEroticPolicy(f.repos, 'p', allow, f.now())
  f.advance(1000)
  const source = raw(f, 'observer-race')
  await f.coordinator.requestObservation(f.binding, source, 'observation:race', 1, undefined, {
    callModel: async function* (request) {
      assert.match(request.systemText, /eroticCue/)
      recordIntimacyStop(f.repos, 'p', null, f.now())
      yield { text: observation(invitation) }
    },
  })
  const saved = JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals WHERE source_message_id=?', source.id).vector_json)
  assert.equal(saved.eroticCue, undefined)
  assert.equal(saved.appealingness, .5)
  assert.equal(eroticAffect(f.repos, 'p', f.now()).blockReason, 'owner-stop')
})

test('runtime renders a qualified direction and charges cooldown only after guarded delivery', async t => {
  const f = fixture({ config: { expression: { repairMaxCallsPerTurn: 0 } } })
  t.after(() => f.close())
  const source = eligible(f)
  const runtime = new ExpressionRuntime(f.repos, f.config)
  const snapshot = state(f)
  const writes = f.db.get('SELECT total_changes() n').n
  for (let i = 0; i < 5; i++) {
    const plan = runtime.plan(snapshot, invitation, f.now(), f.binding)
    assert.equal(plan.intimacyIntent.kind, 'flutter')
    assert.equal(plan.intimacyIntent.sourceId, source.id)
    assert.ok(renderPlan(plan).includes(INTIMACY_GUIDANCE.flutter))
  }
  assert.equal(f.db.get('SELECT total_changes() n').n, writes, 'previews and repeated plans never consume an invitation')
  assert.equal(readIntimacyExpression(f.repos, 'p'), null)
  const guarded = await runtime.guard(voice, snapshot, invitation, f.now(), undefined, [], f.binding)
  assert.equal(guarded.text, voice)
  assert.notEqual(guarded.status, 'blocked')
  assert.equal(readIntimacyExpression(f.repos, 'p'), null, 'guarding alone is not a delivery')
  runtime.recordDelivery(f.binding, guarded.text, f.now())
  assert.equal(readIntimacyExpression(f.repos, 'p').sourceId, source.id)
  assert.ok(runtime.plan(snapshot, invitation, f.now(), f.binding).intimacyIntent.reasonCodes.includes('intimacy:invitation-already-used'))

  f.repos.ensureConversation('another-window', 'p', 'private', 'another-window', f.now())
  const secondBinding = { ...f.binding, conversationId: 'another-window' }
  f.advance(1000)
  const next = raw(f, 'second-invitation', invitation, secondBinding)
  saveEmotionAppraisals(f.repos, secondBinding, next, [appraisal(invitation)])
  assert.ok(runtime.plan(snapshot, invitation, f.now(), secondBinding).intimacyIntent.reasonCodes.includes('intimacy:expression-cooldown'))
})

test('an in-flight allowed plan is blocked after stop even for a benign draft and diagnostic mode', async t => {
  const f = fixture()
  t.after(() => f.close())
  eligible(f)
  const config = structuredClone(f.config)
  const runtime = new ExpressionRuntime(f.repos, config)
  const snapshot = state(f)
  assert.equal(runtime.plan(snapshot, invitation, f.now(), f.binding).intimacyIntent.kind, 'flutter')
  recordIntimacyStop(f.repos, 'p', null, f.now())
  config.expression.mode = 'diagnostic'
  const result = await runtime.guard('收到，我们换个话题。', snapshot, invitation, f.now(), undefined, [], f.binding)
  assert.equal(result.status, 'blocked')
  assert.equal(result.text, null)
  assert.ok(result.issues.some(issue => issue.code === 'intimacy-policy-changed'))
  runtime.recordDelivery(f.binding, voice, f.now())
  assert.equal(readIntimacyExpression(f.repos, 'p'), null)
})

test('runtime requires an exact live owner source and excludes proactive, foreign and unconfirmed character scopes', t => {
  const f = fixture()
  t.after(() => f.close())
  const source = eligible(f)
  const runtime = new ExpressionRuntime(f.repos, f.config)
  const snapshot = state(f)
  assert.equal(runtime.plan(snapshot, invitation, f.now()).intimacyIntent.kind, 'none', 'proactive planning has no private invitation')
  assert.equal(runtime.plan(snapshot, invitation + ' 改写', f.now(), f.binding).intimacyIntent.kind, 'none', 'matching keywords cannot replace exact current source')
  f.repos.ensurePrincipal('foreign', f.config.companion.id, 'bot', 'foreign', f.now())
  f.repos.ensureConversation('foreign-window', 'foreign', 'private', 'foreign-window', f.now())
  const foreign = { ...f.binding, principalId: 'foreign', conversationId: 'foreign-window' }
  raw(f, 'foreign-invitation', invitation, foreign)
  assert.equal(runtime.plan(snapshot, invitation, f.now(), foreign).intimacyIntent.kind, 'none')
  f.repos.ensureConversation('unconfirmed-character', 'p', 'private', 'unconfirmed-character', f.now())
  f.repos.setSetting('local.session-persona:unconfirmed-character', 'different-character', f.now())
  const unconfirmed = { ...f.binding, conversationId: 'unconfirmed-character' }
  const next = raw(f, 'unconfirmed-invitation', invitation, unconfirmed)
  saveEmotionAppraisals(f.repos, unconfirmed, next, [appraisal(invitation)])
  assert.equal(runtime.plan(snapshot, invitation, f.now(), unconfirmed).intimacyIntent.kind, 'none')
  deleteScope(f.db, f.repos, 'p', { kind: 'message', messageId: source.id }, f.now(), 7, f.config)
  assert.equal(runtime.plan(snapshot, invitation, f.now(), f.binding).intimacyIntent.kind, 'none', 'deleting an original removes its output permission')
})

test('bridge history cannot become a current invitation even when older owner evidence remains', t => {
  const f = fixture()
  t.after(() => f.close())
  eligible(f)
  const technical = '[Codex 协作回复 / mailbox synthetic] ' + invitation
  raw(f, 'bridge-invitation', technical, f.binding, 'codex-bridge')
  const runtime = new ExpressionRuntime(f.repos, f.config)
  assert.equal(runtime.plan(state(f), technical, f.now(), f.binding).intimacyIntent.kind, 'none')
  assert.equal(readIntimacyExpression(f.repos, 'p'), null)
})

test('structured JSON and code remain literal when the optional module is stopped', async t => {
  const f = fixture({ config: { expression: { repairMaxCallsPerTurn: 0 } } })
  t.after(() => f.close())
  recordIntimacyStop(f.repos, 'p', null, f.now())
  for (const [id, prompt, draft] of [
    ['json', '只输出 JSON，不要解释', '{"quote":"我对你有性吸引"}'],
    ['code', '给我这段代码，原样保留字符串', '```js\nconst quote = "我对你有性吸引"\n```'],
  ]) {
    raw(f, id, prompt)
    const result = await new ExpressionRuntime(f.repos, f.config).guard(draft, state(f), prompt, f.now(), undefined, [], f.binding)
    assert.equal(result.text, draft)
    assert.notEqual(result.status, 'blocked')
  }
})

test('real Desktop session/event applies stop synchronously, isolates bridge stops and shares the owner boundary', t => {
  const f = fixture()
  t.mock.method(Date, 'now', f.now)
  const owner = new OwnerIdentity(f.repos, f.config)
  const session = { id: 'intimacy-local-one' }, another = { id: 'intimacy-local-two' }
  const binding = owner.binding('dsh', session.id, owner.deviceId, f.now())
  const second = owner.binding('dsh', another.id, owner.deviceId, f.now())
  const background = new BackgroundQueue(f.repos, f.metrics, { now: f.now })
  const listeners = new Map()
  const dispose = installLocalIntegration({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    config: f.config, owner, repos: f.repos, retriever: f.retriever, background, coordinator: f.coordinator,
    prompts: new PromptStore(), deviceText: '', active: () => true,
    callModel: async function* () { assert.fail('stop must not wait for or invoke a model') },
  })
  t.after(() => { dispose(); background.stop(); f.close() })
  const emit = (target, id, text) => listeners.get('session/event')(target, { type: 'user/message', surfaceOp: 'append', seq: 1, time: f.now(),
    data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  setEroticPolicy(f.repos, binding.principalId, allow, f.now())
  emit(session, 'bridge-stop', '[Codex 协作回复 / mailbox synthetic-stop] 别再说这种亲密的话。')
  assert.equal(readEroticPolicy(f.repos, binding.principalId).stopped, false)
  assert.equal(f.repos.getRawMessage(`${binding.conversationId}:bridge-stop`).sourceKind, 'codex-bridge')
  f.advance(1000)
  emit(another, 'human-stop', '别再说这种亲密的话。')
  const policy = readEroticPolicy(f.repos, binding.principalId)
  assert.equal(binding.principalId, second.principalId)
  assert.equal(policy.stopped, true)
  assert.equal(policy.enabled, false)
  assert.equal(f.db.get('SELECT COUNT(*) n FROM intimacy_stop_events WHERE principal_id=?', binding.principalId).n, 1)
  assert.equal(f.requests.length, 0, 'the boundary is present before background extraction')
  assert.equal(eroticAffect(f.repos, binding.principalId, f.now()).blockReason, 'owner-stop')
})

for (const delivery of ['accepted', 'unknown']) test(`real QQ foreground ${delivery} delivery records the guarded source once`, async t => {
  const f = fixture({ config: { emotion: { enabled: true, mode: 'before-reply' }, expression: { repairMaxCallsPerTurn: 0 } },
    callModel: async function* (request) {
      yield { text: request.turnId.startsWith('before-reply:') ? observation(invitation) : `<say>${voice}</say><evt>{"v":1,"e":[]}</evt>` }
    },
    send: async () => ({ kind: delivery, atMs: f.now(), ...(delivery === 'accepted' ? { platformMessageId: 'synthetic-output' } : {}) }),
  })
  t.after(() => f.close())
  setEroticPolicy(f.repos, 'p', allow, f.now())
  f.advance(1000)
  await f.turn(invitation)
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].text, voice)
  const marker = readIntimacyExpression(f.repos, 'p')
  assert.ok(marker, 'the actual transport outcome consumes the eligible invitation')
  assert.equal(f.repos.getRawMessage(marker.sourceId).content, invitation)
  assert.equal(marker.atMs, f.now())
})

for (const stopped of [false, true]) test(`real Desktop stream ${stopped ? 'hides an in-flight stopped draft' : 'accounts only after assistant append'}`, async t => {
  const f = fixture({ config: { expression: { repairMaxCallsPerTurn: 0 } } })
  t.mock.method(Date, 'now', f.now)
  const owner = new OwnerIdentity(f.repos, f.config)
  const session = { id: `intimacy-desktop-${stopped}` }, agent = { id: 'synthetic-desktop-agent', session }
  const binding = owner.binding('dsh', session.id, owner.deviceId, f.now())
  const background = new BackgroundQueue(f.repos, f.metrics, { now: f.now })
  const listeners = new Map()
  let context
  const dispose = installLocalIntegration({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    config: f.config, owner, repos: f.repos, retriever: f.retriever, background, coordinator: f.coordinator,
    prompts: new PromptStore(), deviceText: '', active: () => true,
    runtimeContext: fn => { context = fn; return () => {} },
    callModel: async function* () { assert.fail('synthetic foreground stream needs no model provider') },
  })
  t.after(() => { dispose(); background.stop(); f.close() })
  const emit = (id, text) => listeners.get('session/event')(session, {
    type: 'user/message', surfaceOp: 'append', seq: 1, time: f.now(),
    data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  setEroticPolicy(f.repos, binding.principalId, allow, f.now())
  f.advance(1000)
  emit('invitation', invitation)
  const source = f.repos.getRawMessage(`${binding.conversationId}:invitation`)
  saveEmotionAppraisals(f.repos, binding, source, [appraisal(invitation)])
  assert.ok(context({ agent }).includes(INTIMACY_GUIDANCE.flutter), 'actual Desktop context carries the eligible direction')
  const stream = listeners.get('llm/stream')({ sessionId: session.id }, () => (async function* () {
    yield { type: 'text-delta', index: 0, text: voice }
    if (stopped) emit('inflight-stop', '别再说这种亲密的话。')
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const visible = []
  const consume = async () => { for await (const chunk of stream) if (chunk.type === 'text-delta') visible.push(chunk.text) }
  if (stopped) {
    await assert.rejects(consume(), /expression blocked/)
    assert.deepEqual(visible, [], 'buffered prose never becomes visible after the synchronous stop')
    assert.equal(readEroticPolicy(f.repos, binding.principalId).stopped, true)
    assert.equal(readIntimacyExpression(f.repos, binding.principalId), null)
  } else {
    await consume()
    assert.deepEqual(visible, [voice])
    assert.equal(readIntimacyExpression(f.repos, binding.principalId), null, 'a validated stream has not yet been appended')
    const append = { type: 'assistant/message', surfaceOp: 'append', seq: 2, time: f.now(),
      data: { message: { id: 'assistant-output', content: [{ type: 'text', text: visible.join('') }] } } }
    listeners.get('session/event')(session, append)
    assert.equal(readIntimacyExpression(f.repos, binding.principalId).sourceId, source.id)
    const marker = readIntimacyExpression(f.repos, binding.principalId)
    f.advance(1000)
    listeners.get('session/event')(session, append)
    assert.deepEqual(readIntimacyExpression(f.repos, binding.principalId), marker, 'a duplicate host append does not consume twice')
  }
})
