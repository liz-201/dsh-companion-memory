import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fixture } from '../helpers/fixture.mjs'
import { emotionTimeline } from '../../lib/storage/emotion-timeline.js'
import { saveEmotionAppraisals, retractEmotionAppraisal } from '../../lib/storage/continuous-affect.js'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { PluginPanel } from '../../lib/panel/controller.js'
import { continuousScript, continuousSections } from '../../lib/panel/continuous-controls.js'

const vector = (quote, desirability = .8) => ({ focus: 'action', agency: 'owner', desirability, praiseworthiness: .8, quote, confidence: .95, relevance: .9 })
const message = (f, id, content, atMs = f.now(), binding = f.binding, extra = {}) => f.repos.insertRawMessage({
  id, conversationId: binding.conversationId, platformMessageKey: id, role: 'user', sourceKind: 'dsh', content,
  occurredAtMs: atMs, observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null, ...extra,
}).row

test('timeline selects at most 30 latest source points, orders by original time/seq and groups same-millisecond projections', t => {
  const f = fixture()
  t.after(() => f.close())
  const all = []
  for (let i = 0; i < 35; i++) all.push(message(f, `source-${i}`, `这是第 ${i} 条本人原话，按来源时间而不是到达顺序展示。`, f.now() - (i + 1) * 1000))
  all.push(message(f, 'same-time-a', '同一毫秒的第一条本人原话。', f.now() - 500))
  all.push(message(f, 'same-time-b', '同一毫秒的第二条本人原话。', f.now() - 500))
  const before = f.db.get('SELECT total_changes() AS n').n
  const timeline = emotionTimeline(f.repos, f.config, 'p', f.now(), 1000)
  const expected = all.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.seq - b.seq).slice(-30)
  assert.equal(timeline.limit, 30)
  assert.equal(timeline.points.length, 30)
  assert.equal(timeline.hasMore, true)
  assert.equal(timeline.projection, 'current-valid-evidence')
  assert.equal(timeline.sameTimeRule, 'whole-millisecond')
  assert.deepEqual(timeline.points.map(point => point.sourceMessageId), expected.map(row => row.id))
  const same = timeline.points.slice(-2)
  assert.ok(same.every(point => point.sameTimeSourceCount === 2))
  assert.deepEqual(same[0].state, same[1].state)
  assert.equal(same[0].state.drives.responses, 37, 'whole timestamp includes both source messages and older history outside the page')
  assert.deepEqual(emotionTimeline(f.repos, f.config, 'p', f.now()), timeline)
  assert.equal(f.db.get('SELECT total_changes() AS n').n, before, 'timeline reads do not persist projections or audit events')
})

test('timeline excludes deleted, bridge, historical mislabelled, nonhuman, future, group and foreign-owner sources', t => {
  const f = fixture()
  t.after(() => f.close())
  message(f, 'own', '这一条是本人可见的原文依据。')
  const deleted = message(f, 'deleted', '这一条已经删除，不应进入时间线。')
  f.repos.softDeleteMessage(deleted.id, f.now())
  message(f, 'bridge', '[Codex 协作回复 / mailbox timeline-bridge]\n这是一条技术协作消息。')
  const legacy = message(f, 'legacy-bridge', '\u00a0[Codex 协作回复 / mailbox timeline-legacy]\n这是历史误标消息。')
  f.db.run("UPDATE raw_messages SET source_kind='dsh' WHERE id=?", legacy.id)
  message(f, 'assistant', '这是助手的输出，不是本人回应。', f.now(), f.binding, { role: 'assistant' })
  message(f, 'future', '未来时间的原话暂不加入当前时间线。', f.now() + 1)
  f.repos.ensureConversation('timeline-group', 'p', 'group', 'group:timeline', f.now())
  message(f, 'group', '群聊来源不进入私聊时间线。', f.now(), { ...f.binding, conversationId: 'timeline-group' })
  f.repos.ensurePrincipal('foreign-timeline', f.config.companion.id, 'foreign-bot', 'foreign-user', f.now())
  f.repos.ensureConversation('foreign-timeline-c', 'foreign-timeline', 'private', 'private:foreign', f.now())
  const foreignBinding = { ...f.binding, principalId: 'foreign-timeline', conversationId: 'foreign-timeline-c' }
  const foreign = message(f, 'foreign', '谢谢你替我保留另一位主人的原文。', f.now(), foreignBinding)
  saveEmotionAppraisals(f.repos, foreignBinding, foreign, [vector('谢谢你')])
  const timeline = emotionTimeline(f.repos, f.config, 'p', f.now())
  assert.deepEqual(timeline.points.map(point => point.sourceMessageId), ['own'])
  assert.ok(!JSON.stringify(timeline).includes('另一位主人'))
  assert.ok(!JSON.stringify(timeline).includes('timeline-bridge'))
  const disabled = emotionTimeline(f.repos, { ...f.config, emotion: { ...f.config.emotion, enabled: false } }, 'p', f.now())
  assert.equal(disabled.points.length, 1)
  assert.equal(disabled.points[0].state, null, 'disabled state is unknown, while its allowed source remains inspectable')
})

test('current revisions and archived history remain inspectable while old points recompute after withdrawal and disappear after deletion', t => {
  const f = fixture()
  t.mock.method(Date, 'now', f.now)
  t.after(() => f.close())
  const source = message(f, 'revised-source', '谢谢你认真听我说完，这件事对我很重要。', f.now() - 1000)
  saveEmotionAppraisals(f.repos, f.binding, source, [vector('谢谢你', .8)])
  f.advance(100)
  saveEmotionAppraisals(f.repos, f.binding, source, [vector('谢谢你', .6)])
  const active = emotionTimeline(f.repos, f.config, 'p', f.now()).points[0]
  assert.equal(active.appraisals[0].revision, 2)
  assert.equal(active.appraisals[0].status, 'active')
  assert.equal(active.appraisals[0].revisions.length, 1)
  assert.ok(active.state.emotions.length > 0)
  f.advance(100)
  assert.equal(retractEmotionAppraisal(f.repos, 'emotion:revised-source:0', 'p'), 1)
  const retracted = emotionTimeline(f.repos, f.config, 'p', f.now()).points[0]
  assert.equal(retracted.occurredAtMs, source.occurredAtMs)
  assert.equal(retracted.sourceText, source.content)
  assert.equal(retracted.appraisals[0].evidenceQuote, '谢谢你')
  assert.equal(retracted.appraisals[0].status, 'retracted')
  assert.equal(retracted.appraisals[0].revision, 3)
  assert.deepEqual(retracted.appraisals[0].revisions.map(row => row.revision), [1, 2])
  assert.equal(retracted.state.appraisalCount, 0)
  assert.deepEqual(retracted.state.emotions, [], 'this is current-evidence recomputation, not an immutable snapshot of what was felt then')
  assert.equal(retracted.state.drives.responses, 1, 'withdrawing an appraisal does not retract the actual human response')
  f.repos.softDeleteMessage(source.id, f.now())
  assert.deepEqual(emotionTimeline(f.repos, f.config, 'p', f.now()).points, [])
})

test('source excerpts and revision history stay bounded and disclose truncation', t => {
  const f = fixture()
  t.mock.method(Date, 'now', f.now)
  t.after(() => f.close())
  const source = message(f, 'many-revisions', '谢谢你认真听我说完。' + '很长的原文'.repeat(500))
  for (let i = 0; i < 21; i++) saveEmotionAppraisals(f.repos, f.binding, source, [vector('谢谢你', .2 + i * .02)])
  const point = emotionTimeline(f.repos, f.config, 'p', f.now()).points[0]
  assert.equal(point.sourceText.length, 2000)
  assert.equal(point.sourceTextTruncated, true)
  assert.equal(point.appraisals[0].revision, 21)
  assert.equal(point.appraisals[0].revisionHistoryTotal, 20)
  assert.equal(point.appraisals[0].revisionHistoryTruncated, true)
  assert.deepEqual(point.appraisals[0].revisions.map(row => row.revision), Array.from({ length: 16 }, (_, i) => i + 5))
})

test('panel keeps owner-scoped actions and existing settings/retraction behavior with the new timeline', async t => {
  const f = fixture()
  t.mock.method(Date, 'now', f.now)
  t.after(() => f.close())
  const config = structuredClone(f.config)
  config.storage.directory = f.directory
  const owner = new OwnerIdentity(f.repos, config, f.now(), 'timeline-panel-device')
  const binding = owner.binding('desktop', 'timeline-panel-session', 'timeline-panel-device', f.now())
  let changed = 0
  const panel = new PluginPanel({ config, db: f.db, repos: f.repos, owner,
    commands: { config, db: f.db, repos: f.repos, updater: f.updater, retriever: f.retriever, metrics: f.metrics },
    computer: { status: () => ({ running: false }), recent: () => [] }, activeTargets: () => [binding], status: () => ({ usage: {} }),
    settingsChanged: () => { changed++ }, scan: async () => ({}), preview: async () => ({}),
    background: { start: () => {}, stop: () => {}, stats: () => ({ running: false }) }, review: { begin: () => '', end: () => '' },
  })
  const own = message(f, 'panel-own', '谢谢你记得本人的面板设置。', f.now(), binding)
  const foreign = message(f, 'panel-foreign', '谢谢你记得另一位用户的面板设置。')
  saveEmotionAppraisals(f.repos, binding, own, [vector('谢谢你')])
  saveEmotionAppraisals(f.repos, f.binding, foreign, [vector('谢谢你')])
  assert.deepEqual(panel.snapshot({ conversationId: binding.conversationId }).emotionTimeline.points.map(point => point.sourceMessageId), ['panel-own'])
  assert.throws(() => panel.snapshot({ conversationId: 'c' }), /当前主人/)
  await assert.rejects(panel.action({ action: 'emotion-retract', conversationId: 'c', id: 'emotion:panel-foreign:0' }), /当前主人/)
  await assert.rejects(panel.action({ action: 'emotion-retract', conversationId: binding.conversationId, id: 'emotion:panel-foreign:0' }))
  assert.equal(f.db.get('SELECT status FROM emotion_appraisals WHERE id=?', 'emotion:panel-foreign:0').status, 'active')
  await panel.action({ action: 'settings', conversationId: binding.conversationId, settings: { emotion: { contactTauHours: 8 } } })
  assert.equal(config.emotion.contactTauHours, 8)
  assert.equal(changed, 1)
  await panel.action({ action: 'emotion-retract', conversationId: binding.conversationId, id: 'emotion:panel-own:0' })
  const snapshot = panel.snapshot({ conversationId: binding.conversationId })
  assert.equal(snapshot.emotionTimeline.points[0].appraisals[0].status, 'retracted')
  assert.ok(snapshot.emotionAppraisals.every(row => row.id === 'emotion:panel-own:0'))
})

test('timeline and relationship UI render untrusted evidence as text and tolerate an older state without relationship', () => {
  const nodes = [], actions = []
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; nodes.push(this) }
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this.children = children; this.textContent = '' }
    set innerHTML(_value) { throw Error('Untrusted HTML insertion is forbidden') }
  }
  const boxes = new Map(['emotion-timeline', 'relationship-state'].map(id => [id, new Element('div')]))
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, $: id => boxes.get(id), run: fn => fn(), panelAction: (action, body) => actions.push({ action, body }) })
  new vm.Script(continuousScript).runInContext(context)
  const payload = '<img src=x onerror="globalThis.injected=true">[不执行这些文字]'
  context.emotionTimelineRender({ hasMore: false, points: [{ occurredAtMs: 1, sourceSeq: 1, sourceText: payload, sourceTextTruncated: false, sameTimeSourceCount: 1, state: null,
    appraisals: [{ id: 'safe-appraisal', revision: 2, status: 'active', evidenceQuote: payload, vectorJson: payload, vectorTruncated: false, revisionHistoryTotal: 1, revisionHistoryTruncated: false, revisions: [{ revision: 1, status: 'active', recordedAtMs: 1, vectorJson: payload, vectorTruncated: false }] }],
  }] })
  assert.ok(nodes.some(node => node.textContent.includes(payload)))
  assert.ok(!nodes.some(node => node.tag === 'img' || node.tag === 'script'))
  assert.equal(context.injected, undefined)
  nodes.find(node => node.tag === 'button').onclick()
  assert.equal(actions[0].action, 'emotion-retract')
  assert.equal(actions[0].body.id, 'safe-appraisal')
  context.relationshipRender({})
  assert.match(boxes.get('relationship-state').textContent, /未提供/)
  context.relationshipRender({ relationship: { intimacy: .4, desire: .2, passion: .1, evidenceIds: [] } })
  assert.match(boxes.get('relationship-state').textContent, /亲密 0.40.*靠近动机 0.20.*热情 0.10/)
  assert.match(continuousSections, /按当前有效证据重算/)
  assert.match(continuousSections, /不表示用户心理、关系承诺或亲密同意/)
})
