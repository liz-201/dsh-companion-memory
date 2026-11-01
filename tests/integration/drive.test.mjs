import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DESIRE_REPORT_THRESHOLD,
  DRIVE_REPORT_THRESHOLD,
  DRIVE_TRACE_FLOOR,
  advanceDrives,
  applyUserReply,
  desireOf,
  drivesOf,
  longingCap,
  longingLevel,
  renderDriveLine,
  settleDrives,
} from '../../lib/domain/drive.js'
import { initialSnapshot, projectSnapshot, reduce, settleDrivesForUserMessage } from '../../lib/domain/affect-reducer.js'
import { emptyDelta } from '../../lib/domain/episode-manager.js'
import { fixedClock } from '../../lib/domain/types.js'
import { renderStateBlock } from '../../lib/runtime/context-builder.js'
import { resolveConfig } from '../../lib/config.js'

const config = resolveConfig()
const affect = config.affect
const T0 = 1_760_000_000_000 // 2025-10-09T08:53:20Z
const HOUR = 60 * 60 * 1000

function makeContext(over = {}) {
  return {
    dailyUsed: emptyDelta(),
    fromInboundUserMessage: true,
    // 稳定源消息 id：驱力的「被回应」按它去重，不用毫秒。
    replyMark: 'msg-d05',
    establishedTeasingContext: false,
    roleplay: false,
    idempotencyKey: 'idem-drive',
    seenIdempotencyKeys: new Set(),
    ...over,
  }
}

function appraisal(over = {}) {
  return {
    sourceMessageId: 'msg-drive',
    kind: 'warmth',
    intent: 'neutral',
    target: 'self',
    severity: 1,
    confidence: 0.9,
    source: 'live_tail',
    revision: 1,
    occurredAtMs: T0,
    ...over,
  }
}

test('D01 空白期累积：无事件的 6 小时也算进等待，且越过报告阈值', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const later = projectSnapshot(base, T0 + 6 * HOUR, affect)
  assert.ok(later.drives !== undefined, 'projectSnapshot 必须补出 drives')
  assert.ok(later.drives.longing > 0, `longing 应随空白增长，实际 ${later.drives.longing}`)
  assert.ok(later.drives.longing >= DRIVE_REPORT_THRESHOLD, `6 小时后应越过报告阈值，实际 ${later.drives.longing}`)
})

test('D02 同一时刻重复结算不翻倍（幂等）', () => {
  const drives = settleDrives(undefined, T0, 0.15)
  const once = settleDrives(drives, T0 + 3 * HOUR, 0.15)
  const twice = settleDrives(once, T0 + 3 * HOUR, 0.15)
  assert.equal(once.longing, twice.longing)
  assert.equal(once.lastSettledAtMs, twice.lastSettledAtMs)
})

test('D03 单调性：时间越久越长，且不超过好感调制后的上限', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const samples = [1, 3, 6, 12, 48, 240].map(hours => projectSnapshot(base, T0 + hours * HOUR, affect).drives.longing)
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index] >= samples[index - 1], `序列应非递减：${samples.join(',')}`)
  }
  const cap = longingCap(base.relationship.affection)
  assert.ok(samples[samples.length - 1] <= cap + 1e-9, `不得超过 cap=${cap}，实际 ${samples[samples.length - 1]}`)
  assert.ok(cap > 0.5 && cap <= 0.95, `cap 应在合理区间，实际 ${cap}`)
})

test('D04 被回应：快速下降但留痕，不归零', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const high = projectSnapshot(base, T0 + 12 * HOUR, affect).drives
  const replied = applyUserReply(high)
  assert.ok(replied.longing < high.longing, '被回应后必须下降')
  assert.ok(replied.longing >= DRIVE_TRACE_FLOOR, `必须留痕，实际 ${replied.longing}`)
  assert.ok(replied.longing > 0, '不得归零，否则等于没有等待过')
})

test('D05 reduce 链路：inbound 用户消息会削掉已累积的期待，非 inbound 不会', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const clock = fixedClock(T0 + 12 * HOUR)
  const pending = projectSnapshot(base, T0 + 12 * HOUR, affect)
  const inbound = reduce(pending, appraisal({ occurredAtMs: T0 + 12 * HOUR }), clock, affect, makeContext())
  const notInbound = reduce(
    pending,
    appraisal({ occurredAtMs: T0 + 12 * HOUR }),
    clock,
    affect,
    makeContext({ fromInboundUserMessage: false, idempotencyKey: 'idem-drive-2' }),
  )
  assert.ok(inbound.next.drives.longing < pending.drives.longing, 'inbound 应下降')
  assert.ok(
    notInbound.next.drives.longing >= pending.drives.longing,
    `非 inbound 不得下降：${notInbound.next.drives.longing} vs ${pending.drives.longing}`,
  )
})

test('D06 旧快照没有 drives 字段也能读，不抛错', () => {
  const legacy = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  delete legacy.drives
  const drives = drivesOf(legacy)
  assert.equal(drives.longing, 0)
  assert.equal(drives.lastSettledAtMs, T0)
  const block = renderStateBlock(projectSnapshot(legacy, T0 + HOUR, affect))
  assert.equal(typeof block, 'string')
})

test('D07 渲染：低档位不出现，高档位出现且不含原始数值', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const quiet = renderStateBlock(projectSnapshot(base, T0 + 60 * 1000, affect))
  assert.ok(!quiet.includes('未了的心事'), '低档位不该每轮都提')

  const heavy = projectSnapshot(base, T0 + 48 * HOUR, affect)
  const block = renderStateBlock(heavy)
  assert.ok(block.includes('未了的心事'), '高档位应出现')
  assert.ok(!/\d/.test(block.split('未了的心事')[1].split('\n')[0]), '不得泄露原始数值')
  assert.ok(block.includes('不许索取'), '硬约束必须随行注入')
})

test('D08 情欲分量：低亲密时不触发「想被靠近」', () => {
  const low = desireOf({ longing: 0.6, desire: 0, lastSettledAtMs: T0 }, 0, 0)
  assert.ok(low < DESIRE_REPORT_THRESHOLD, `低亲密不应越过阈值，实际 ${low}`)
  const line = renderDriveLine({ longing: 0.6, desire: low, lastSettledAtMs: T0 })
  assert.ok(!line.includes('想被靠近'))
  const high = settleDrives({ longing: 0.3, desire: 0, lastSettledAtMs: T0 }, T0 + 60 * HOUR, 0.9, {
    intimacy: 0.95,
    recentIntimacyHit: 1,
  })
  assert.ok(high.desire >= DESIRE_REPORT_THRESHOLD, `高亲密应越过阈值，实际 ${high.desire}`)
})

test('D09 分级单调：longing 越大等级不下降', () => {
  const order = [0, 0.1, 0.25, 0.4, 0.6, 0.8, 0.95]
  const ranks = order.map(value => ['none', 'faint', 'clear', 'heavy', 'unbearable'].indexOf(longingLevel(value)))
  for (let index = 1; index < ranks.length; index += 1) {
    assert.ok(ranks[index] >= ranks[index - 1], `等级序列应非递减：${order.map(v => longingLevel(v)).join(',')}`)
  }
})

test('D10 advanceDrives 是纯函数：不修改入参', () => {
  const before = { longing: 0.2, desire: 0.1, lastSettledAtMs: T0 }
  const snapshot = { ...before }
  advanceDrives(before, T0 + 2 * HOUR, { affection: 0.3, trust: 0.5, respect: 0.5, familiarity: 0.2, grievance: 0 }, true)
  assert.deepEqual(before, snapshot)
})

test('D11 同一条用户消息的多个 appraisal 只结算一次（不连乘 0.35）', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const pending = projectSnapshot(base, T0 + 12 * HOUR, affect)
  const rel = pending.relationship
  const first = advanceDrives(pending.drives, T0 + 12 * HOUR, rel, true, { replyMark: 'msg-4242' })
  const second = advanceDrives(first, T0 + 12 * HOUR, rel, true, { replyMark: 'msg-4242' })
  assert.deepEqual(second, first, '同一 replyMark 必须幂等')
  const third = advanceDrives(first, T0 + 12 * HOUR, rel, true, { replyMark: 'msg-4243' })
  assert.ok(third.longing < first.longing, '下一条消息仍应继续下降')
})

test('D12 e=[] 的普通回复也降低期待（按消息结算，不依赖事件个数）', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const pending = projectSnapshot(base, T0 + 12 * HOUR, affect)
  assert.ok(pending.drives.longing > DRIVE_REPORT_THRESHOLD)
  const settled = settleDrivesForUserMessage(pending, { nowMs: T0 + 12 * HOUR, replyMark: 'msg-77' })
  assert.ok(settled.longing < pending.drives.longing, '没有 appraisal 的普通回复同样要降')
  assert.deepEqual(
    settleDrivesForUserMessage({ ...pending, drives: settled }, { nowMs: T0 + 12 * HOUR, replyMark: 'msg-77' }),
    settled,
    '同一消息重复结算必须幂等',
  )
})

test('D13 读投影幂等且不丢失亲密余温：desire 不被重算成 0.3×longing', () => {
  const warm = initialSnapshot('principal-2', 'balanced', affect.ruleVersion, T0)
  warm.relationship = { ...warm.relationship, affection: 0.5, familiarity: 0.7 }
  warm.drives = { longing: 0.5, desire: 0.72, lastSettledAtMs: T0 }
  const once = projectSnapshot(warm, T0 + 1, affect)
  const twice = projectSnapshot(warm, T0 + 1, affect)
  assert.deepEqual(twice.drives, once.drives, '同一时刻重复投影必须逐字节相同')
  const sameMs = projectSnapshot(warm, T0, affect)
  assert.equal(sameMs.drives.desire, warm.drives.desire, '同毫秒读取不得改变状态')
  assert.ok(once.drives.desire > 0.3 * once.drives.longing + 0.2, `desire 应带上亲密度，实际 ${once.drives.desire}`)
})

test('D14 报告阈值统一：0.34 不说，0.35 才说', () => {
  assert.equal(renderDriveLine({ longing: 0.34, desire: 0, lastSettledAtMs: T0 }), '')
  assert.equal(longingLevel(0.34), 'none')
  assert.ok(renderDriveLine({ longing: DRIVE_REPORT_THRESHOLD, desire: 0, lastSettledAtMs: T0 }).includes('未了的心事'))
})

test('D15 空状态被回应后不得被 floor 抬高成新的想念', () => {
  const empty = { longing: 0, desire: 0, lastSettledAtMs: T0 }
  const replied = applyUserReply(empty, 'msg-1')
  assert.equal(replied.longing, 0, '原本没攒下的东西，回复不应造出来')
  assert.equal(renderDriveLine(replied), '')
})

test('D16 同一毫秒的两条不同消息仍是两条消息：各扣一次，不被毫秒时间吞掉', () => {
  const rel = { affection: .6, trust: .5, respect: .5, familiarity: .5, grievance: 0 }
  const pending = { driving: { longing: .8, desire: .3, lastSettledAtMs: T0 } }
  const sameMs = T0 + 12 * HOUR
  const first = advanceDrives(pending.driving, sameMs, rel, true, { replyMark: 'in-1' })
  const second = advanceDrives(first, sameMs, rel, true, { replyMark: 'in-2' })
  assert.ok(second.longing < first.longing, '第二条消息必须再扣一次')
  assert.equal(second.lastReplyMark, 'in-2')
})

test('D17 没有稳定消息 id 时不扣：宁可少扣一次，也不拿毫秒冒充身份', () => {
  const rel = { affection: .6, trust: .5, respect: .5, familiarity: .5, grievance: 0 }
  const pending = { longing: .5, desire: .3, lastSettledAtMs: T0 }
  const sameMs = T0 + 12 * HOUR
  const settled = advanceDrives(pending, sameMs, rel, true, {})
  const noReply = settleDrives(pending, sameMs, rel.affection, { intimacy: rel.familiarity })
  assert.deepEqual(settled, noReply, '无 id 时结果必须与「没有回应」完全一致')
  assert.equal(settled.lastReplyMark, undefined)
})

test('D18 上限被调低时向下夹到新上限，不长期越界', () => {
  const high = settleDrives({ longing: .95, desire: 0, lastSettledAtMs: T0 }, T0 + 60 * 60 * 1000, 0)
  assert.ok(high.longing <= longingCap(0), '好感低时上限更小，旧值必须被夹下来')
})

test('D19 经 reduce 的真实边界：同一毫秒的两条不同源消息各结算一次', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const pending = projectSnapshot(base, T0 + 12 * HOUR, affect)
  const clock = fixedClock(T0 + 12 * HOUR)
  const first = reduce(pending, appraisal({ sourceMessageId: 'in-1', occurredAtMs: T0 + 12 * HOUR }), clock, affect, makeContext({ replyMark: undefined }))
  const second = reduce(first.next, appraisal({ sourceMessageId: 'in-2', occurredAtMs: T0 + 12 * HOUR }), clock, affect, makeContext({ replyMark: undefined, idempotencyKey: 'idem-drive-b' }))
  assert.ok(first.next.drives.longing < pending.drives.longing, '第一条应下降')
  assert.ok(second.next.drives.longing < first.next.drives.longing, '同毫秒的第二条也必须再降一次')
  assert.equal(second.next.drives.lastReplyMark, 'in-2')
})

test('D20 同一条源消息的第二个 appraisal 只结算一次（不连乘 0.35）', () => {
  const base = initialSnapshot('principal-1', 'balanced', affect.ruleVersion, T0)
  const pending = projectSnapshot(base, T0 + 12 * HOUR, affect)
  const clock = fixedClock(T0 + 12 * HOUR)
  const first = reduce(pending, appraisal({ sourceMessageId: 'in-9', occurredAtMs: T0 + 12 * HOUR }), clock, affect, makeContext({ replyMark: undefined }))
  const again = reduce(first.next, appraisal({ sourceMessageId: 'in-9', occurredAtMs: T0 + 12 * HOUR, kind: 'teasing' }), clock, affect, makeContext({ replyMark: undefined, idempotencyKey: 'idem-drive-c' }))
  assert.equal(again.next.drives.longing, first.next.drives.longing, '同一消息不得二次削减')
})

test('D21 旧快照的 lastReplyMark 是数字时仍可读，并与字符串 id 正确比较', () => {
  const legacy = { longing: .5, desire: .2, lastSettledAtMs: T0, lastReplyMark: 4242 }
  assert.equal(drivesOf({ drives: legacy, asOfMs: T0 }).lastReplyMark, '4242')
  const rel = { affection: .6, trust: .5, respect: .5, familiarity: .5, grievance: 0 }
  const same = advanceDrives(legacy, T0 + 12 * HOUR, rel, true, { replyMark: 4242 })
  const other = advanceDrives(legacy, T0 + 12 * HOUR, rel, true, { replyMark: 'in-77' })
  assert.ok(other.longing <= same.longing, '不同 id 才允许再扣一次')
  assert.equal(same.lastReplyMark, '4242')
})
