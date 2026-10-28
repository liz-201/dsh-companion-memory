import test from 'node:test'
import assert from 'node:assert/strict'
import { projectRelationshipDynamics as project, RELATIONSHIP_DYNAMICS_DEFAULTS as defaults } from '../../lib/domain/relationship-dynamics.js'

const minute = 60000, now = Date.parse('2026-10-29T00:00:00+08:00')
const event = (sourceId, extra = {}) => ({ sourceId, atMs: now, ...extra })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

test('an empty or legacy history does not invent desire, passion, or a promise', () => {
  const empty = project([], now)
  assert.equal(empty.intimacy, defaults.initialIntimacy)
  assert.equal(empty.desire, 0)
  assert.equal(empty.passion, 0)
  assert.deepEqual(empty.evidenceIds, [])
  assert.equal(empty.sourceCount, 0)
  assert.equal('commitment' in empty, false)
  assert.equal('trust' in empty, false)
  assert.equal(project([event('legacy', { appealingness: 1 })], now).desire, 0)
})

test('stable high intimacy and twenty neutral interactions cannot sustain passion', () => {
  const boost = event('closer', { intimacyDelta: .8 })
  const parameters = { initialIntimacy: .8, intimacyGain: .1 }
  const initial = project([boost], now, parameters)
  const neutral = Array.from({ length: 20 }, (_, index) => event(`neutral-${index}`, { atMs: now + (index + 1) * 30 * minute }))
  const later = project([boost, ...neutral], now + 600 * minute, parameters)
  assert.ok(initial.passion > 0)
  assert.ok(later.passion < initial.passion / 100)
  assert.equal(later.intimacy, initial.intimacy)
  assert.equal(later.desire, 0)
})

test('fresh positive closeness can produce more passion than a stable high level', () => {
  const stable = project([event('old', { intimacyDelta: .2, atMs: now - 600 * minute })], now, { initialIntimacy: .8 })
  const growing = project(Array.from({ length: 5 }, (_, index) => event(`grow-${index}`, { intimacyDelta: .6, atMs: now - (4 - index) * minute })), now)
  assert.ok(growing.intimacy < stable.intimacy)
  assert.ok(growing.passion > stable.passion)
})

test('falling intimacy never increases passion and never creates desire', () => {
  const warm = event('warm', { intimacyDelta: 1, pull: .6 })
  const earlier = project([warm], now)
  const falling = project([warm, event('distance', { atMs: now + minute, intimacyDelta: -.8 })], now + minute)
  const merelyWaiting = project([warm], now + minute)
  assert.ok(falling.intimacy < earlier.intimacy)
  assert.ok(falling.passion < merelyWaiting.passion)
  assert.equal(falling.desire, merelyWaiting.desire)
  assert.equal(project([event('distance', { intimacyDelta: -1 })], now).passion, 0)
  const ambivalent = project([warm, event('distance', { atMs: now + minute, intimacyDelta: -.1, pull: .8 })], now + minute)
  assert.ok(ambivalent.passion <= merelyWaiting.passion)
})

test('desire comes from explicit pull independently of the existing intimacy level', () => {
  const source = event('approach', { pull: .8 })
  const low = project([source], now, { initialIntimacy: .1 })
  const high = project([source], now, { initialIntimacy: .9 })
  assert.ok(low.desire > 0)
  assert.equal(low.desire, high.desire)
  assert.equal(low.passion, high.passion)
  assert.equal(low.intimacy, .1)
  assert.equal(high.intimacy, .9)
})

test('explicit withdrawal reduces both transient axes without rewriting intimacy', () => {
  const sources = [event('approach', { pull: 1 })]
  const before = project(sources, now + minute)
  const after = project([...sources, event('withdraw', { atMs: now + minute, pull: -.1 })], now + minute)
  assert.ok(after.desire < before.desire)
  assert.ok(after.passion < before.passion)
  assert.equal(after.intimacy, before.intimacy)
})

test('withdrawal dominates same-millisecond approach instead of becoming a passion reward', () => {
  const result = project([event('yes', { pull: 1, intimacyDelta: 1 }), event('no', { pull: -.1 })], now)
  assert.equal(result.desire, 0)
  assert.equal(result.passion, 0)
  assert.ok(result.intimacy > defaults.initialIntimacy)
  assert.equal(result.sourceCount, 2)
})

test('silence only decays transients and does not punish a long-term relationship', () => {
  const sources = [event('warm', { intimacyDelta: .5, pull: .8 })]
  const initial = project(sources, now)
  const later = project(sources, now + 360 * minute)
  assert.equal(later.intimacy, initial.intimacy)
  near(later.desire, initial.desire / 4)
  near(later.passion, initial.passion / 64)
})

test('repeated identical source IDs do not count as additional interaction', () => {
  const source = event('same-source', { intimacyDelta: .6, pull: .7 })
  assert.deepEqual(project([source, source, { ...source }], now), project([source], now))
})

test('a higher source revision replaces all prior effects instead of stacking them', () => {
  const first = event('edited', { intimacyDelta: .8, pull: .9 })
  const revised = event('edited', { intimacyDelta: -.3, pull: -.5, revision: 2 })
  assert.deepEqual(project([first, revised], now), project([revised], now))
  assert.deepEqual(project([revised, first], now), project([revised], now))
  const neutral = event('edited', { revision: 3 })
  const cleared = project([first, revised, neutral], now)
  assert.equal(cleared.desire, 0)
  assert.equal(cleared.passion, 0)
  assert.equal(cleared.intimacy, defaults.initialIntimacy)
  assert.deepEqual(cleared.evidenceIds, [])
})

test('a retraction or removal reconstructs the same state as the remaining sources', () => {
  const sources = [event('keep', { pull: .5 }), event('remove', { intimacyDelta: 1, pull: .9 })]
  const retracted = { ...sources[1], revision: 1, status: 'retracted' }
  assert.deepEqual(project([...sources, retracted], now), project(sources.slice(0, 1), now))
})

test('same revision with different content is rejected instead of depending on import order', () => {
  const first = event('collision', { pull: .3, revision: 2 })
  const other = event('collision', { pull: .8, revision: 2 })
  assert.throws(() => project([first, other], now), /Conflicting relationship source revision/)
  assert.throws(() => project([other, first], now), /Conflicting relationship source revision/)
})

test('a higher correction supersedes conflicts in older revisions regardless of input order', () => {
  const first = event('corrected', { pull: .2, revision: 1 })
  const second = event('corrected', { pull: .8, revision: 1 })
  const corrected = event('corrected', { pull: .4, revision: 2 })
  assert.deepEqual(project([first, second, corrected], now), project([corrected, second, first], now))
  assert.deepEqual(project([first, corrected, second], now), project([corrected], now))
})

test('different sources in one millisecond both count with order-independent clamps', () => {
  const sources = [event('a', { intimacyDelta: .8, pull: .8 }), event('b', { intimacyDelta: .7, pull: .6 })]
  const combined = project(sources, now)
  assert.equal(combined.sourceCount, 2)
  assert.ok(combined.desire > project(sources.slice(0, 1), now).desire)
  assert.deepEqual(combined.evidenceIds, ['a', 'b'])
  assert.deepEqual(combined, project([...sources].reverse(), now))
  const mixed = [event('positive', { intimacyDelta: 1 }), event('negative', { intimacyDelta: -1 })]
  assert.deepEqual(project(mixed, now, { initialIntimacy: .99 }), project([...mixed].reverse(), now, { initialIntimacy: .99 }))
})

test('unsorted, delayed and serialized sources replay to exactly the same state', () => {
  const sources = [event('third', { atMs: now + 3 * minute, intimacyDelta: -.2 }), event('first', { pull: .8 }), event('second', { atMs: now + minute, intimacyDelta: .5 })]
  const chronological = [...sources].sort((a, b) => a.atMs - b.atMs)
  assert.deepEqual(project(sources, now + 10 * minute), project(chronological, now + 10 * minute))
  assert.deepEqual(project(sources, now + 10 * minute), project(JSON.parse(JSON.stringify(sources)), now + 10 * minute))
})

test('future sources and future revisions do not alter a past projection', () => {
  const past = event('source', { pull: .4 })
  const future = event('source', { atMs: now + minute, pull: -.8, revision: 1 })
  assert.deepEqual(project([past, future], now), project([past], now))
  assert.equal(project([past], now - 1).sourceCount, 0)
  assert.equal(project([future], now).desire, 0)
})

test('invalid times, sources, signals and revisions fail before producing a poisoned state', () => {
  for (const atMs of [NaN, Infinity, -Infinity, 1.5, 9e15]) assert.throws(() => project([], atMs), /Invalid relationship/)
  for (const extra of [{ atMs: NaN }, { atMs: Infinity }, { pull: NaN }, { pull: 1.01 }, { pull: -1.01 }, { intimacyDelta: Infinity }, { intimacyDelta: 1.01 }, { revision: -1 }, { revision: .5 }, { revision: null }, { status: 'unknown' }, { status: null }]) assert.throws(() => project([event('invalid', extra)], now), /Invalid relationship/)
  for (const sourceId of ['', ' ', 'a\nb']) assert.throws(() => project([event(sourceId)], now), /Invalid relationship source/)
})

test('invalid parameter overrides are rejected and finite alternate calibrations stay bounded', () => {
  for (const extra of [null, [], NaN, { unknown: 1 }, { initialIntimacy: NaN }, { intimacyGain: 1.1 }, { desireGain: -1 }, { passionIntimacyGain: Infinity }, { passionHalfLifeMinutes: 0 }, { desireHalfLifeMinutes: -1 }, { desireHalfLifeMinutes: 1e308 }, { withdrawalDesireLoss: 1.1 }]) assert.throws(() => project([], now, extra), /Invalid relationship parameter/)
  const sources = Array.from({ length: 20 }, (_, index) => event(`max-${index}`, { pull: 1, intimacyDelta: 1, atMs: now + index }))
  const value = project(sources, now + 20, { initialIntimacy: 1, intimacyGain: 1, desireGain: 1, passionPullGain: 1 })
  for (const key of ['intimacy', 'desire', 'passion']) assert.ok(value[key] >= 0 && value[key] <= 1)
})

test('frozen sources and parameter objects are not mutated by repeated reads', () => {
  const sources = Object.freeze([Object.freeze(event('a', { pull: .8, intimacyDelta: .3 }))])
  const parameters = Object.freeze({ initialIntimacy: .2 })
  const first = project(sources, now + 20 * minute, parameters)
  const original = JSON.stringify(sources)
  assert.deepEqual(project(sources, now + 20 * minute, parameters), first)
  assert.equal(JSON.stringify(sources), original)
  assert.deepEqual(parameters, { initialIntimacy: .2 })
})

test('ten thousand mixed sources reconstruct exactly after restart and source removal', () => {
  const sources = Array.from({ length: 10000 }, (_, index) => event(`s-${String(index).padStart(5, '0')}`, { atMs: now + index * minute, ...(index % 11 === 0 ? { intimacyDelta: .05 } : {}), ...(index % 17 === 0 ? { pull: .2 } : {}), ...(index % 23 === 0 ? { pull: -.1 } : {}) }))
  const atMs = now + 10000 * minute
  const uninterrupted = project(sources, atMs)
  assert.deepEqual(uninterrupted, project(JSON.parse(JSON.stringify(sources)).reverse(), atMs))
  const remaining = sources.filter((_, index) => index % 100 !== 0)
  const tombstones = sources.filter((_, index) => index % 100 === 0).map(source => ({ ...source, status: 'retracted', revision: 1 }))
  assert.deepEqual(project([...sources, ...tombstones], atMs), project(remaining, atMs))
})
