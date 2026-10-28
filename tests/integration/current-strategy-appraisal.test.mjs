import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { currentStrategyAppraisal, observationStrategyAppraisals } from '../../lib/runtime/strategy-appraisal.js'

const apology = { k: 'apology', to: 'self', i: 'repair', s: 2, c: .99 }
const appreciation = { k: 'appreciation', to: 'self', i: 'neutral', s: 2, c: .99 }
const observation = event => `<observation>${JSON.stringify({ v: 2, legacy: { v: 1, e: event ? [event] : [] }, appraisals: [] })}</observation>`
const message = (f, id, text = '对不起，刚才是我说重了') => f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id,
  role: 'user', sourceKind: 'qq', content: text, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row

for (const [event, text, expected] of [[apology, '对不起，刚才是我说重了', /对方在缓和/u], [appreciation, '谢谢你一直认真回答', /可以自然接住/u]]) {
  test(`QQ current ${event.k} pre-evaluation reaches the foreground strategy without settling legacy twice`, async () => {
    const f = fixture({ config: { emotion: { mode: 'before-reply' } }, callModel: async function* (request) {
      yield { text: request.turnId.startsWith('before-reply:') ? observation(event) : '<say>收到</say><evt>{"v":1,"e":[]}</evt>' }
    } })
    try {
      await f.turn(text)
      assert.equal(f.requests.length, 2)
      assert.match(f.requests[1].systemText, expected)
      assert.equal(f.db.get('SELECT COUNT(*) n FROM appraisals').n, 0)
      assert.equal(f.db.get('SELECT COUNT(*) n FROM affect_events').n, 0)
      assert.equal(f.db.get('SELECT COUNT(*) n FROM response_events').n, 1)
      assert.equal(f.sends.length, 1)
    } finally { f.close() }
  })
}

test('background mode never borrows a previous message appraisal for the current turn', async () => {
  const f = fixture({ callModel: async function* () { yield { text: '<say>收到</say><evt>{"v":1,"e":[]}</evt>' } } })
  try {
    const prior = message(f, 'previous')
    await f.coordinator.observe(f.binding, prior, { v: 1, e: [apology] })
    f.advance(1000)
    await f.turn('今天聊点别的')
    assert.doesNotMatch(f.requests.at(-1).systemText, /对方在缓和/u)
    assert.equal(f.requests.length, 1)
  } finally { f.close() }
})

test('current appraisal requires matching source, owner, live content, eligibility and quote', () => {
  const f = fixture()
  try {
    const raw = message(f, 'current')
    const cues = observationStrategyAppraisals({ v: 1, e: [apology] }, raw)
    const read = (binding = f.binding, source = raw, list = cues) => currentStrategyAppraisal(f.repos, binding, source, f.config.affect, list)
    assert.equal(read().kind, 'apology')
    assert.equal(read({ ...f.binding, principalId: 'other-owner' }), undefined)
    assert.equal(read(f.binding, raw, [{ ...cues[0], sourceMessageId: 'previous' }]), undefined)
    assert.equal(read(f.binding, raw, [{ ...cues[0], evidenceQuote: '不是原话' }]), undefined)
    assert.equal(read(f.binding, raw, [{ ...cues[0], confidence: .2 }]), undefined)
    f.db.run('UPDATE raw_messages SET content=? WHERE id=?', '原话已被编辑', raw.id)
    assert.equal(read(), undefined)
    f.db.run('UPDATE raw_messages SET content=?,deleted_at_ms=? WHERE id=?', raw.content, f.now(), raw.id)
    assert.equal(read(), undefined)
  } finally { f.close() }
})

test('quoted hostility and a bridge message cannot supply a strategy appraisal', () => {
  const f = fixture()
  try {
    const raw = message(f, 'quote', '他说你很笨，这是引用，不是我在骂你')
    const insult = { k: 'insult', to: 'self', i: 'hostile', s: 3, c: .99 }
    assert.equal(currentStrategyAppraisal(f.repos, f.binding, raw, f.config.affect, observationStrategyAppraisals({ v: 1, e: [insult] }, raw)), undefined)
    const bridge = message(f, 'bridge', '[Codex 协作回复 / mailbox strategy-test] 对不起，修复已经完成')
    assert.equal(currentStrategyAppraisal(f.repos, f.binding, bridge, f.config.affect, observationStrategyAppraisals({ v: 1, e: [apology] }, bridge)), undefined)
  } finally { f.close() }
})

test('timed-out pre-evaluation cannot retroactively steer or duplicate the foreground reply', async () => {
  const f = fixture({ config: { emotion: { mode: 'before-reply', timeoutMs: 100 } }, callModel: async function* (request) {
    if (request.turnId.startsWith('before-reply:')) { await new Promise(resolve => setTimeout(resolve, 180)); yield { text: observation(apology) } }
    else yield { text: '<say>收到</say><evt>{"v":1,"e":[]}</evt>' }
  } })
  try {
    await f.turn('对不起，刚才是我说重了')
    assert.doesNotMatch(f.requests[1].systemText, /对方在缓和/u)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(f.sends.length, 1)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM appraisals').n, 0)
  } finally { f.close() }
})
