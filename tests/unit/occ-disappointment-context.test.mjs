import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyOcc } from '../../lib/domain/occ-classifier.js'

const event = { focus: 'event', affectedParty: 'self', quote: '测试原文', confidence: .95, relevance: .9 }
const pendingPositive = { ...event, desirability: .8, prospect: 'pending', likelihood: .6 }

test('plain negative events keep distress and do not invent 失落', () => {
  const result = classifyOcc({ ...event, desirability: -.8 })
  assert.ok(result.components.some(c => c.category === 'distress'))
  assert.equal(result.displays.includes('失落'), false)
})

test('a failed positive expectation is explicit 失落', () => {
  const result = classifyOcc({ ...event, prospect: 'disconfirmed' }, pendingPositive)
  assert.ok(result.components.some(c => c.category === 'disappointment'))
  assert.ok(result.displays.includes('失落'))
})

test('confirmed hope and mild or unrelated negative events are not 失落', () => {
  assert.equal(classifyOcc({ ...event, prospect: 'confirmed' }, pendingPositive).displays.includes('失落'), false)
  assert.equal(classifyOcc({ ...event, desirability: -.2 }).displays.includes('失落'), false)
  assert.equal(classifyOcc({ ...event, affectedParty: 'owner', desirability: -.8 }).displays.includes('失落'), false)
})

test('a missing prior expectation yields a reason instead of a guessed display word', () => {
  const result = classifyOcc({ ...event, prospect: 'disconfirmed' })
  assert.ok(result.reasons.includes('missing-prior-expectation'))
  assert.equal(result.displays.includes('失落'), false)
})

test('other display words keep their own evidence and are untouched', () => {
  assert.ok(classifyOcc({ ...event, desirability: -.8, agency: 'owner', unfairness: .9 }).displays.includes('委屈'))
  assert.ok(classifyOcc({ ...event, affectedParty: 'owner', desirabilityForOther: -.8, likingForOther: .8, helplessness: .9 }).displays.includes('心酸'))
  assert.ok(classifyOcc({ ...event, prospect: 'disconfirmed' }, { ...event, desirability: -.8, prospect: 'pending', likelihood: .6 }).displays.includes('安心'))
})
