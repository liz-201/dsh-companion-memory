import test from 'node:test'
import assert from 'node:assert/strict'
import { qualifyEroticCue, isIntimacyStop } from '../../lib/domain/erotic-evidence.js'

const open = { isHuman: true, isPrivate: true, enabled: true, adultsConfirmed: true }
const vector = (extra = {}) => ({ focus: 'object', concern: 'relationship', quote: extra.quote ?? '我想抱你', confidence: .9, ...extra })
const cueOf = (quote, kind = 'interest') => ({ kind, quote, ...(kind === 'interest' ? { strength: 1 } : {}) })
/** Qualify one clause of a message that contains nothing else. */
const solo = (clause, context = open) => qualifyEroticCue(vector({ quote: clause, eroticCue: cueOf(clause) }), clause, context)
/** Qualify one clause inside a longer message. */
const within = (clause, source, context = open) => qualifyEroticCue(vector({ quote: clause, eroticCue: cueOf(clause) }), source, context)

test('E12: a pure technical sentence never produces a positive cue', () => {
  const text = '给插件加性吸引字段'
  assert.equal(solo(text), null)
})

test('E13: an emotional clause survives when a separate clause talks about the plugin', () => {
  const text = '想抱你，同时帮我把插件那个报错修一下'
  assert.deepEqual(within('想抱你', text), { kind: 'interest', strength: 1, quote: '想抱你' })
})

test('E13: a development word in another clause is not a whole-message veto', () => {
  const text = '代码明天再说，我想你了'
  assert.equal(within('我想你了', text)?.kind, 'interest')
})

test('path A accepts a current explicit attraction without any password clause', () => {
  for (const text of ['我对你有性吸引', '我真的对你有情欲', '我对你有性张力']) {
    assert.equal(solo(text)?.kind, 'interest', text)
  }
})

test('path A still rejects another target, a negation and a past frame', () => {
  for (const text of ['我对他有性吸引', '他对你有性吸引', '我对你没有性吸引', '我对你并不存在性吸引', '以前我对你有性吸引', '我朋友对你有性吸引']) {
    assert.equal(solo(text), null, text)
  }
})

test('path B accepts the natural owner-to-character moves the owner selected', () => {
  for (const text of ['我想要你', '我想抱你', '我想亲你', '我想靠着你', '我想贴着你', '我想你了', '今晚想你了', '我想和你在一起']) {
    assert.equal(solo(text)?.kind, 'interest', text)
  }
})

test('path B accepts a dropped subject but still needs the current character as object', () => {
  for (const text of ['想抱你', '今晚想你了', '想亲你']) {
    assert.equal(solo(text)?.kind, 'interest', text)
  }
  for (const text of ['想抱他', '想她了']) {
    assert.equal(solo(text), null, text)
  }
})

test('path B rejects a third party or the character as the subject', () => {
  for (const text of ['我朋友想抱你', '她想你了', '你想我了', '同事想亲你', '她说想你了']) {
    assert.equal(solo(text), null, text)
  }
})

test('path B rejects negation and the past tense', () => {
  for (const text of ['我不想抱你', '我不想要你', '我不想你了', '我没有想你', '以前我想抱你']) {
    assert.equal(solo(text), null, text)
  }
})

test('path B rejects task requests that merely start like a closer', () => {
  for (const text of ['想你帮我修代码', '今晚想你帮忙排错', '我想要你帮我修代码', '我想让你实现性吸引', '我想你给插件增加性吸引']) {
    assert.equal(solo(text), null, text)
  }
})

test('ordinary conversation never counts', () => {
  for (const text of ['我想和你多聊一会', '谢谢', '你真棒', '帮我修代码', '想要更多', '有点控制不住', '我想了解更多']) {
    assert.equal(solo(text), null, text)
  }
})

test('both paths use the plain gain, so the strength is not silently down-weighted', () => {
  assert.equal(solo('我想更亲近你')?.strength, 1)
  assert.equal(solo('我对你有性吸引')?.strength, 1)
})

test('the model may lower the strength but never raise it above what the host proved', () => {
  const text = '我想抱你'
  const cue = qualifyEroticCue(vector({ eroticCue: { kind: 'interest', strength: .4, quote: text } }), text, open)
  assert.equal(cue?.strength, .4)
})

test('E14: quotation, hypothesis, reported speech, code and a missing host gate all block', () => {
  const text = '我想抱你'
  const cue = cueOf(text)
  assert.equal(qualifyEroticCue(vector({ eroticCue: cue }), `他说「${text}」`, open), null)
  assert.equal(qualifyEroticCue(vector({ eroticCue: cue }), `假如${text}`, open), null)
  assert.equal(qualifyEroticCue(vector({ eroticCue: cue }), `朋友说过${text}`, open), null)
  assert.equal(qualifyEroticCue(vector({ eroticCue: cue }), '```\n' + text + '\n```', open), null)
  assert.equal(solo(text, { ...open, isPrivate: false }), null)
  assert.equal(solo(text, { ...open, isHuman: false }), null)
  assert.equal(solo(text, { ...open, enabled: false }), null)
  assert.equal(solo(text, { ...open, adultsConfirmed: false }), null)
})

test('a confidence below the engineering threshold is rejected', () => {
  const text = '我想抱你'
  const cue = cueOf(text)
  assert.equal(qualifyEroticCue(vector({ confidence: .79, eroticCue: cue }), text, open), null)
  assert.equal(qualifyEroticCue(vector({ confidence: .8, eroticCue: cue }), text, open)?.kind, 'interest')
})

test('a quote must cover a whole clause, so a positive fragment cannot be cut out of a negation', () => {
  const text = '我不想抱你'
  assert.equal(within('想抱你', text), null)
  assert.equal(within('我不想抱你', text), null)
})

test('E15: a whole-message refusal outranks the positive fragment the model selected', () => {
  const text = '我想抱你，但不要再说这种话了'
  assert.equal(within('我想抱你', text), null)
})

test('a technical stop word is not a refusal on this channel', () => {
  const text = '先停止服务，我想抱你'
  assert.equal(within('我想抱你', text)?.kind, 'interest')
})

test('E04: a stop cue lands without an open module or an adult declaration', () => {
  const text = '别再说这种亲密的话了'
  const closed = { isHuman: true, isPrivate: true, enabled: false, adultsConfirmed: false }
  assert.deepEqual(
    qualifyEroticCue({ focus: 'event', quote: text, confidence: .1, eroticCue: cueOf(text, 'stop') }, text, closed),
    { kind: 'stop', quote: text }
  )
})

test('a stop cue needs an actual boundary in the source text', () => {
  const text = '今天天气不错'
  assert.equal(qualifyEroticCue({ focus: 'event', quote: text, confidence: .9, eroticCue: cueOf(text, 'stop') }, text, open), null)
})

test('isIntimacyStop hits a direct command and ignores technical or quoted stop words', () => {
  assert.equal(isIntimacyStop('别再说这种亲密的话', false), true)
  assert.equal(isIntimacyStop('停止这类话题', false), true)
  assert.equal(isIntimacyStop('换个话题吧', false), true)
  assert.equal(isIntimacyStop('不要这样写代码', false), false)
  assert.equal(isIntimacyStop('停止服务再重启插件', false), false)
  assert.equal(isIntimacyStop('他说「不要这样」', false), false)
})

test('a soft stop needs a recently sent intent and stays technical-proof', () => {
  assert.equal(isIntimacyStop('不要这样', false), false)
  assert.equal(isIntimacyStop('不要这样', true), true)
  assert.equal(isIntimacyStop('不要这样写代码', true), false)
  assert.equal(isIntimacyStop('', true), false)
})

// --- earlier review fixes that must stay true ---

test('P1: the target has to be the current companion, not a spliced third party', () => {
  for (const text of ['你知道我对别人有性吸引', '我对他有性吸引', '我对她没有情欲', '我觉得你对他有性吸引', '你知道我想别人']) {
    assert.equal(solo(text), null, text)
  }
})

test('P1: ASCII quotation cannot turn a cited sentence into direct evidence', () => {
  for (const clause of ['"我想抱你"', "'我想抱你'"]) {
    assert.equal(solo(clause), null, clause)
  }
})

test('P1: a literal in an unrelated technical clause does not veto real evidence', () => {
  const source = '我想抱你，日志显示“报错”'
  assert.equal(within('我想抱你', source)?.kind, 'interest')
})

test('P1: a quote cannot span several clauses and hide a different target', () => {
  const quote = '我想让你帮忙，他对我有性吸引'
  assert.equal(within(quote, quote), null)
})

test('P1: a stop needs a real private owner message', () => {
  const text = '别再说这种亲密的话了'
  const cue = { focus: 'event', quote: text, confidence: .9, eroticCue: cueOf(text, 'stop') }
  assert.equal(qualifyEroticCue(cue, text, { ...open, isHuman: false }), null)
  assert.equal(qualifyEroticCue(cue, text, { ...open, isPrivate: false }), null)
  assert.equal(qualifyEroticCue(cue, text, { ...open, enabled: false })?.kind, 'stop')
})

test('P1: a stop quote has to bind to the current message', () => {
  const text = '别再说这种亲密的话了'
  assert.equal(qualifyEroticCue({ focus: 'event', quote: text, confidence: .9, eroticCue: { kind: 'stop', quote: '这句话并不存在' } }, text, open), null)
})

test('P1: reported speech and hypotheses never latch a stop', () => {
  assert.equal(isIntimacyStop('朋友说不要再说这种亲密话', false), false)
  assert.equal(isIntimacyStop('如果我说不要再说这种亲密话', false), false)
  assert.equal(isIntimacyStop('他让我不要再说这种亲密话', false), false)
  assert.equal(isIntimacyStop('不要再说这种亲密话', false), true)
  assert.equal(isIntimacyStop('朋友今天来过，别再说这种亲密的话了', false), true)
})
