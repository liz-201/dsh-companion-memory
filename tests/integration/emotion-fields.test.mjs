import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { continuousAffect } from '../../lib/storage/continuous-affect.js'
import { qualifiedOwnerPull } from '../../lib/domain/relationship-evidence.js'

const scenes = [
  ['object', '你喜欢的那本书到了', { appealingness: .8 }, ['appealingness'], 'love'],
  ['object', '你讨厌的那个摆件又出现了', { appealingness: -.8 }, ['appealingness'], 'hate'],
  ['action', '我特意记得帮你找回了资料', { agency: 'owner', praiseworthiness: .8, desirability: .8, personalAttention: .9 }, ['praiseworthiness', 'agency'], 'gratitude'],
  ['event', '你等的包裹到了', { affectedParty: 'self', desirability: .8 }, ['affectedParty', 'desirability'], 'joy'],
  ['event', '我考过了，你一直盼着我成功', { affectedParty: 'owner', desirabilityForOther: .8, likingForOther: .8 }, ['desirabilityForOther', 'likingForOther'], 'happy-for'],
  ['event', '那个你不喜欢的人得到了不该得的奖励', { affectedParty: 'other', desirabilityForOther: .8, likingForOther: -.8, deservingness: -.8 }, ['deservingness'], 'resentment'],
]

// The real coordinator builds the observer request, parses the envelope, binds the
// quote to the persisted inbound, saves it, and projects the downstream emotion.
for (const [focus, text, fields, required, category] of scenes) {
  for (const missing of [undefined, ...required]) {
    test(`${focus} observer to storage to ${category}: ${missing ? `unknown ${missing}` : 'complete fields'}`, async () => {
      const vector = { focus, quote: text, confidence: .95, ...fields }
      if (missing) delete vector[missing]
      const f = fixture({ config: { emotion: { mode: 'before-reply' } }, callModel: async function* (request) {
        if (request.turnId.startsWith('before-reply:')) {
          assert.match(request.systemText, /object：必须提供 appealingness/)
          assert.match(request.systemText, /action：必须提供 praiseworthiness 和 agency/)
          assert.match(request.systemText, /event：必须提供 affectedParty/)
          assert.match(request.systemText, /未知字段仍省略/)
          yield { text: `<observation>${JSON.stringify({ v: 2, appraisals: [vector] })}</observation>` }
        } else yield { text: '<say>收到</say><evt>{"v":1,"e":[]}</evt>' }
      } })
      try {
        await f.turn(text)
        const row = f.db.get('SELECT vector_json, source_message_id FROM emotion_appraisals')
        assert.ok(row)
        assert.equal(f.repos.getRawMessage(row.source_message_id).content, text)
        if (missing) assert.equal(missing in JSON.parse(row.vector_json), false)
        const state = continuousAffect(f.repos, f.config, 'p', f.now())
        assert.equal(state.emotions.some(e => e.category === category), !missing)
        if (category === 'gratitude') assert.equal(state.displays.includes('被重视感'), !missing)
      } finally { f.close() }
    })
  }
}

for (const text of ['喜欢和你聊天', '我喜欢和你聊天', '想你了', '我想你了', '多陪我一会', '你多陪我一会']) {
  test(`explicit companionship survives observation and replay: ${text}`, async () => {
    const f = fixture({ config: { emotion: { mode: 'before-reply' } }, callModel: async function* (request) {
      yield { text: request.turnId.startsWith('before-reply:')
        ? `<observation>${JSON.stringify({ v: 2, appraisals: [{ focus: 'object', quote: text, confidence: .95, pull: .8 }] })}</observation>`
        : '<say>收到</say><evt>{"v":1,"e":[]}</evt>' }
    } })
    try {
      await f.turn(text)
      assert.equal(JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals').vector_json).pull, .8)
      const state = continuousAffect(f.repos, f.config, 'p', f.now())
      assert.ok(state.relationship.desire > 0)
      assert.ok(state.relationship.passion > 0)
      assert.equal(state.emotions.some(e => e.category === 'love'), false)
      assert.deepEqual(continuousAffect(f.repos, f.config, 'p', f.now()), state)
    } finally { f.close() }
  })
}

test('expanded companionship gate preserves source boundaries and uncertainty', () => {
  for (const [source, quote] of [
    ['他说想你了', '想你了'], ['引用：多陪我一会', '多陪我一会'],
    ['如果可以，多陪我一会', '多陪我一会'], ['工作安排：多陪我一会', '多陪我一会'],
    ['陪我测试，想你了', '想你了'], ['我不想你了', '我不想你了'],
    ['我不喜欢和你聊天', '喜欢和你聊天'], ['不用多陪我一会', '多陪我一会'],
    ['别主动联系我，想你了', '想你了'], ['我喜欢这本书', '我喜欢这本书'],
  ]) assert.equal(qualifiedOwnerPull({ focus: 'object', quote, confidence: .95, pull: .8 }, source, true), undefined, source)
  const vector = { focus: 'object', quote: '多陪我一会', confidence: .95, pull: .8 }
  assert.equal(qualifiedOwnerPull(vector, vector.quote, false), undefined)
  assert.equal(qualifiedOwnerPull({ ...vector, confidence: .64 }, vector.quote, true), undefined)
  assert.equal(qualifiedOwnerPull({ ...vector, pull: undefined }, vector.quote, true), undefined)
})

test('observer-selected companionship substrings cannot persist pull from work, reports or refusal', async () => {
  for (const text of ['工作安排：多陪我一会', '他说多陪我一会', '不用多陪我一会']) {
    const f = fixture({ config: { emotion: { mode: 'before-reply' } }, callModel: async function* (request) {
      yield { text: request.turnId.startsWith('before-reply:')
        ? '<observation>{"v":2,"appraisals":[{"focus":"object","quote":"多陪我一会","confidence":0.95,"pull":0.8}]}</observation>'
        : '<say>收到</say><evt>{"v":1,"e":[]}</evt>' }
    } })
    try {
      await f.turn(text)
      assert.equal('pull' in JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals').vector_json), false)
      const state = continuousAffect(f.repos, f.config, 'p', f.now())
      assert.equal(state.relationship.desire, 0)
      assert.equal(state.relationship.passion, 0)
    } finally { f.close() }
  }
})
