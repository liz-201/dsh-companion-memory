import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEmotionContract, EMOTION_CONTRACT, parseObservation } from '../../lib/runtime/emotion-observation.js'
import { parseAppraisals } from '../../lib/domain/emotion-appraisal.js'

const wrap = appraisals => `<observation>{"v":3,"legacy":{"v":1,"e":[]},"appraisals":${JSON.stringify(appraisals)}}</observation>`

test('the base contract stays byte-identical and never mentions the new cue', () => {
  assert.equal(buildEmotionContract(), EMOTION_CONTRACT)
  assert.equal(buildEmotionContract(false), EMOTION_CONTRACT)
  assert.equal(EMOTION_CONTRACT.includes('eroticCue'), false)
})

test('the erotic appendix appears only when the caller asks for it', () => {
  const withCue = buildEmotionContract(true)
  assert.ok(withCue.startsWith(EMOTION_CONTRACT))
  assert.ok(withCue.length > EMOTION_CONTRACT.length)
  assert.ok(withCue.includes('eroticCue'))
  assert.ok(withCue.includes('"kind":"interest"'))
  assert.ok(withCue.includes('"kind":"stop"'))
})

test('a well-formed interest cue round-trips through the parser', () => {
  const parsed = parseObservation(wrap([{
    focus: 'object', concern: 'relationship', quote: '我对你有性吸引', confidence: .9,
    eroticCue: { kind: 'interest', strength: .8, quote: '我对你有性吸引' }
  }]))
  assert.equal(parsed.appraisals?.[0]?.eroticCue?.kind, 'interest')
  assert.equal(parsed.appraisals?.[0]?.eroticCue?.strength, .8)
  assert.equal(parsed.appraisals?.[0]?.eroticCue?.quote, '我对你有性吸引')
})

test('a stop cue carries no strength', () => {
  const parsed = parseObservation(wrap([{
    focus: 'event', concern: 'relationship', affectedParty: 'self', desirability: -.6,
    quote: '别再说这种亲密的话', confidence: .9,
    eroticCue: { kind: 'stop', quote: '别再说这种亲密的话' }
  }]))
  assert.equal(parsed.appraisals?.[0]?.eroticCue?.kind, 'stop')
  assert.equal('strength' in (parsed.appraisals?.[0]?.eroticCue ?? {}), false)
})

test('E21: forged host fields inside the cue are rejected', () => {
  const base = { focus: 'object', concern: 'relationship', quote: '我对你有性吸引', confidence: .9 }
  for (const cue of [
    { kind: 'interest', strength: .5, quote: '我对你有性吸引', owner: 'someone' },
    { kind: 'interest', strength: .5, quote: '我对你有性吸引', adultsConfirmed: true },
    { kind: 'interest', strength: .5, quote: '我对你有性吸引', sourceId: 'x' },
    { kind: 'interest', strength: .5, quote: '我对你有性吸引', atMs: 1 }
  ]) {
    assert.throws(() => parseAppraisals([{ ...base, eroticCue: cue }]), /server-owned erotic cue field/)
  }
})

test('E21: invalid kinds, quotes and strengths are rejected', () => {
  const base = { focus: 'object', concern: 'relationship', quote: '我对你有性吸引', confidence: .9 }
  assert.throws(() => parseAppraisals([{ ...base, eroticCue: { kind: 'want', quote: '我对你有性吸引' } }]), /invalid erotic cue kind/)
  assert.throws(() => parseAppraisals([{ ...base, eroticCue: { kind: 'interest', strength: .5, quote: '' } }]), /invalid erotic cue quote/)
  assert.throws(() => parseAppraisals([{ ...base, eroticCue: { kind: 'interest', strength: .5, quote: 'x'.repeat(301) } }]), /invalid erotic cue quote/)
  assert.throws(() => parseAppraisals([{ ...base, eroticCue: { kind: 'interest', strength: 1.5, quote: '我对你有性吸引' } }]), /strength in \[0,1\]/)
  assert.throws(() => parseAppraisals([{ ...base, eroticCue: { kind: 'interest', quote: '我对你有性吸引' } }]), /strength in \[0,1\]/)
  assert.throws(() => parseAppraisals([{ ...base, eroticCue: { kind: 'stop', strength: .5, quote: '别说了' } }]), /must not carry a strength/)
})

test('an object vector that carries only an erotic cue is not forced to invent appealingness', () => {
  const parsed = parseObservation(wrap([{
    focus: 'object', concern: 'relationship', quote: '我对你有性吸引', confidence: .9,
    eroticCue: { kind: 'interest', strength: .5, quote: '我对你有性吸引' }
  }]))
  assert.equal(parsed.appraisals?.length, 1)
})

test('an object vector without pull or cue still requires appealingness', () => {
  assert.throws(() => parseObservation(wrap([{ focus: 'object', concern: 'relationship', quote: '书到了', confidence: .9 }])), /appealingness/)
})

test('a legacy observation without the new field still parses unchanged', () => {
  const parsed = parseObservation(wrap([{ focus: 'event', concern: 'self', affectedParty: 'self', desirability: -.6, quote: '一直失败', confidence: .9 }]))
  assert.equal(parsed.appraisals?.[0]?.eroticCue, undefined)
  assert.equal(parsed.appraisals?.[0]?.desirability, -.6)
})
