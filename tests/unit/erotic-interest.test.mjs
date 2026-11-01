import test from 'node:test'
import assert from 'node:assert/strict'
import { projectEroticInterest as project, EROTIC_INTEREST_DEFAULTS as defaults } from '../../lib/domain/erotic-interest.js'

const minute = 60000
const t0 = Date.parse('2026-11-01T12:00:00+08:00')
const open = { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 }
const event = (sourceId, extra = {}) => ({ sourceId, atMs: t0, strength: 1, ...extra })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

test('an empty history stays unknown instead of reporting a measured zero', () => {
  const state = project([], t0, open)
  assert.equal(state.value, null)
  assert.deepEqual(state.evidenceIds, [])
  assert.equal(state.blocked, false)
  assert.equal(state.blockReason, null)
  assert.equal(state.version, 'erotic-interest-v1')
  assert.equal(state.parameterVersion, 'erotic-engineering-v1')
})

test('E01: one qualified source at full strength reaches exactly the gain', () => {
  const state = project([event('a')], t0, open)
  near(state.value, .30)
  assert.deepEqual(state.evidenceIds, ['a'])
})

test('E02: three sources sixty minutes apart compose by decay, not by plain addition', () => {
  const events = [
    event('a', { atMs: t0 }),
    event('b', { atMs: t0 + 60 * minute }),
    event('c', { atMs: t0 + 120 * minute })
  ]
  const state = project(events, t0 + 120 * minute, open)
  near(state.value, .30 * (2 ** (-120 / 720) + 2 ** (-60 / 720) + 1))
  near(state.value, .8504319092466098)
})

test('E03: one half-life later the value halves and no other axis is touched', () => {
  const state = project([event('a')], t0 + 720 * minute, open)
  near(state.value, .15)
  assert.equal('trust' in state, false)
  assert.equal('intimacy' in state, false)
  assert.equal('desire' in state, false)
  assert.equal('passion' in state, false)
})

test('E05: reading the projection ten thousand times cannot raise it', () => {
  const events = [event('a')]
  const first = project(events, t0 + 30 * minute, open)
  let last = first
  for (let index = 0; index < 10000; index += 1) last = project(events, t0 + 30 * minute, open)
  assert.equal(last.value, first.value)
  assert.equal(events.length, 1)
})

test('E06: a higher revision replaces the earlier contribution instead of stacking', () => {
  const revised = project([event('a', { strength: .5, revision: 2 })], t0, open)
  near(revised.value, .15)
  const both = project([event('a'), event('a', { strength: .5, revision: 2 })], t0, open)
  near(both.value, .15)
  assert.deepEqual(both.evidenceIds, ['a'])
})

test('E07: removing the only positive source returns to unknown, never to zero', () => {
  assert.equal(project([event('a', { status: 'retracted' })], t0, open).value, null)
  assert.equal(project([], t0, open).value, null)
})

test('E08: a late or out-of-order import replays to the same value as the sorted history', () => {
  const ordered = [event('a', { atMs: t0 }), event('b', { atMs: t0 + 60 * minute })]
  const shuffled = [event('b', { atMs: t0 + 60 * minute }), event('a', { atMs: t0 })]
  const at = t0 + 200 * minute
  assert.equal(project(shuffled, at, open).value, project(ordered, at, open).value)
  assert.deepEqual(project(shuffled, at, open).evidenceIds, ['a', 'b'])
})

test('a same-revision disagreement drops the whole source instead of picking a side', () => {
  const state = project([event('a', { strength: .2 }), event('a', { strength: .9 })], t0, open)
  assert.equal(state.value, null)
  assert.deepEqual(state.evidenceIds, [])
})

test('E22: the value is capped at one and future-dated events never apply', () => {
  const saturated = project(Array.from({ length: 12 }, (_, index) => event(`s${index}`, { atMs: t0 - (11 - index) * minute })), t0, open)
  assert.ok(saturated.value <= 1)
  const future = project([event('a', { atMs: t0 + 60 * minute })], t0, open)
  assert.equal(future.value, null)
})

test('E22: a clock that runs backwards does not decay or rewind the trace', () => {
  const events = [event('a')]
  const earlier = project(events, t0 - 60 * minute, open)
  assert.equal(earlier.value, null)
})

test('zeroing takes the earlier of the epsilon floor and the hard retention bound', () => {
  // epsilon is reached first at this half-life; the seven-day bound is the backstop.
  const floored = project([event('a')], t0 + 5000 * minute, open)
  near(floored.value, .30 * 2 ** (-5000 / 720))
  assert.ok(floored.value > defaults.epsilon)
  const zeroed = project([event('a')], t0 + 5925 * minute, open)
  assert.equal(zeroed.value, 0)
  const aged = project([event('a')], t0 + 10080 * minute, open)
  assert.equal(aged.value, 0)
})

test('reason precedence is owner-stop, then adult-context-unknown, then disabled', () => {
  const stop = project([event('a')], t0, { enabled: true, adultsConfirmed: true, stopped: true, epochMs: 0 })
  assert.equal(stop.blockReason, 'owner-stop')
  assert.equal(stop.blocked, true)
  assert.equal(stop.value, 0)

  const adult = project([event('a')], t0, { enabled: true, adultsConfirmed: false, stopped: true, epochMs: 0 })
  assert.equal(adult.blockReason, 'owner-stop')

  const unknown = project([event('a')], t0, { enabled: true, adultsConfirmed: false, stopped: false, epochMs: 0 })
  assert.equal(unknown.blockReason, 'adult-context-unknown')
  assert.equal(unknown.value, null)

  const disabled = project([event('a')], t0, { enabled: false, adultsConfirmed: true, stopped: false, epochMs: 0 })
  assert.equal(disabled.blockReason, 'disabled')
  assert.equal(disabled.value, null)
  assert.equal(disabled.blocked, true)
})

test('a stop outranks old evidence: no elapsed time or warmth revives it', () => {
  const events = [event('a'), event('b', { atMs: t0 + minute })]
  for (const atMs of [t0, t0 + 10080 * minute, t0 + 999999 * minute]) {
    const state = project(events, atMs, { enabled: true, adultsConfirmed: true, stopped: true, epochMs: 0 })
    assert.equal(state.value, 0)
    assert.deepEqual(state.evidenceIds, [])
  }
})

test('a resumed epoch accepts only evidence that came after it', () => {
  const old = event('old', { atMs: t0 })
  const fresh = event('fresh', { atMs: t0 + 60 * minute })
  const resumed = { enabled: true, adultsConfirmed: true, stopped: false, epochMs: t0 + 30 * minute }
  const state = project([old, fresh], t0 + 60 * minute, resumed)
  near(state.value, .30)
  assert.deepEqual(state.evidenceIds, ['fresh'])
  assert.equal(project([old], t0 + 60 * minute, resumed).value, null)
})

test('an invalid event is rejected rather than partially projected', () => {
  assert.throws(() => project([{ sourceId: '', atMs: t0, strength: 1 }], t0, open), /source id/)
  assert.throws(() => project([{ sourceId: 'a', atMs: Number.NaN, strength: 1 }], t0, open), /finite timestamp/)
  assert.throws(() => project([{ sourceId: 'a', atMs: t0, strength: 1.5 }], t0, open), /\[0,1\]/)
  assert.throws(() => project([{ sourceId: 'a', atMs: t0, strength: Number.NaN }], t0, open), /\[0,1\]/)
  assert.throws(() => project([{ sourceId: 'a', atMs: t0, strength: 1, status: 'gone' }], t0, open), /status/)
})

// --- P1 review fixes (Codex 2026-11-01) ---

test('P1: a retraction at a higher revision cancels the active one below it', () => {
  const events = [
    { sourceId: 'a', atMs: 1000, strength: 1, revision: 1, status: 'active' },
    { sourceId: 'a', atMs: 2000, strength: 0, revision: 2, status: 'retracted' }
  ]
  const state = project(events, 3000, { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 })
  assert.equal(state.value, null)
  assert.deepEqual(state.evidenceIds, [])
})

test('P1: a retraction only cancels its own source, not the others', () => {
  const events = [
    { sourceId: 'a', atMs: 1000, strength: 1, revision: 1, status: 'active' },
    { sourceId: 'a', atMs: 2000, strength: 0, revision: 2, status: 'retracted' },
    { sourceId: 'b', atMs: 2000, strength: 1, revision: 1, status: 'active' }
  ]
  const state = project(events, 2000, { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 })
  assert.equal(state.value, .3)
  assert.deepEqual(state.evidenceIds, ['b'])
})

test('P1: a same-revision conflict on timestamp or status drops the source too', () => {
  const base = { sourceId: 'a', strength: 1, revision: 3, status: 'active' }
  const byTime = project([{ ...base, atMs: 1000 }, { ...base, atMs: 1500 }], 3000, { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 })
  assert.equal(byTime.value, null)
  const byStatus = project([{ ...base, atMs: 1000 }, { ...base, atMs: 1000, status: 'retracted' }], 3000, { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 })
  assert.equal(byStatus.value, null)
})

test('P1: an identical duplicate at the same revision is still one contribution', () => {
  const event = { sourceId: 'a', atMs: 1000, strength: 1, revision: 3, status: 'active' }
  const state = project([event, { ...event }], 1000, { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 })
  assert.equal(state.value, .3)
})
