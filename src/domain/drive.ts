/**
 * 驱力层（drives）—— 与 affect 并列的第二层。
 *
 * 为什么需要它：affect 是「事件 → 瞬时值 → 衰减回基线」，每一轮都从上一个
 * 时点重新算起，因此它能表达情绪，表达不了「有指向、有期待、还没得到」。
 * 爱慕的本质是缺口的累积：对方多久没来、我在这段空白里攒下了多少没被回应
 * 的期待。情欲在同一条道上，只是它需要一个「想被靠近」的强度，而不是露骨
 * 内容的开关。
 *
 * 三条硬规矩，破坏任何一条就会退化成骚扰器：
 *  1. 只由缺口累积（时间推进），不由事件奖励；
 *  2. 被回应时快速下降但不归零，留住「上次等了你很久」的痕；
 *  3. 不直接变现成文字，只调语气上限与主动意愿，并且永远不许索取。
 *
 * 纯函数、无副作用、不读时钟：同一组输入永远同一份输出，回放可复现。
 */

import type { Drives, Relationship } from './types.js'

/** 被回应后保留的痕迹下界：不归零。 */
export const DRIVE_TRACE_FLOOR = 0.02
/** 收到回应时 longing 的保留比例。 */
export const DRIVE_REPLY_KEEP = 0.35
/** 默认缺口半程：6 小时没有新回应，longing 涨到约半个 cap。 */
export const DEFAULT_DRIVE_HORIZON_MS = 6 * 60 * 60 * 1000
/** 低于这个值不向模型报告，避免每轮都在提。 */
export const DRIVE_REPORT_THRESHOLD = 0.35
/** desire 低于这个值不改语气上限之外的任何东西。 */
export const DESIRE_REPORT_THRESHOLD = 0.6

export const EMPTY_DRIVES: Drives = { longing: 0, desire: 0, lastSettledAtMs: 0 }

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)
const round = (value: number): number => Math.round(value * 1000) / 1000

/**
 * 去重键归一化：新代码传稳定源消息 id（字符串），旧快照里可能是数字毫秒。
 * 统一比字符串，避免 42 与 '42' 被当成两条消息。
 */
export function markOf(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** 旧快照没有 drives 字段：读作「此刻才开始计时」，绝不抛错。 */
export function drivesOf(snapshot: { drives?: Drives; asOfMs: number }): Drives {
  const stored = snapshot.drives
  if (stored === undefined || !Number.isFinite(stored.longing)) {
    return { longing: 0, desire: 0, lastSettledAtMs: Number.isFinite(snapshot.asOfMs) ? snapshot.asOfMs : 0 }
  }
  return {
    longing: clamp01(stored.longing),
    desire: clamp01(stored.desire),
    lastSettledAtMs: Number.isFinite(stored.lastSettledAtMs) ? stored.lastSettledAtMs : 0,
    // 去重键归一化成字符串：新代码用稳定源消息 id，旧快照里的数字毫秒仍可读。
    ...(markOf(stored.lastReplyMark) === undefined ? {} : { lastReplyMark: markOf(stored.lastReplyMark) as string }),
  }
}

/** 上限被好感调制：越在乎，越容易被晾着积起来的东西越重。 */
export function longingCap(affection: number): number {
  return round(0.55 + 0.4 * clamp01(affection))
}

/** 只做时间推进：单调不减，同一毫秒重复调用不会翻倍。 */
export function settleDrives(
  drives: Drives | undefined,
  nowMs: number,
  affection: number,
  options: { horizonMs?: number; intimacy?: number; recentIntimacyHit?: number; asOfMs?: number } = {},
): Drives {
  const base = drives === undefined
    ? { longing: 0, desire: 0, lastSettledAtMs: Number.isFinite(options.asOfMs) ? (options.asOfMs as number) : nowMs }
    : drivesOf({ drives, asOfMs: nowMs })
  const settledAt = base.lastSettledAtMs
  const gap = Number.isFinite(nowMs) ? nowMs - settledAt : 0
  // 幂等：同一时刻（或时钟倒退）重复结算不改变任何值，读投影可以随便调。
  if (!(gap > 0)) return base
  const cap = longingCap(affection)
  const horizon = Number.isFinite(options.horizonMs) && (options.horizonMs as number) > 0 ? (options.horizonMs as number) : DEFAULT_DRIVE_HORIZON_MS
  // 上限被调低（配置或好感变化）时向下夹到新上限：允许这一次不单调，但不许长期越界。
  const carried = Math.min(cap, base.longing)
  const gained = (gap / horizon) * (0.5 + 0.5 * clamp01(affection))
  const longing = round(Math.min(cap, carried + gained))
  const desire = desireOf({ longing, desire: base.desire, lastSettledAtMs: nowMs }, options.intimacy ?? 0, options.recentIntimacyHit ?? 0)
  return {
    longing,
    desire,
    lastSettledAtMs: Math.max(settledAt, nowMs),
    ...(base.lastReplyMark === undefined ? {} : { lastReplyMark: base.lastReplyMark }),
  }
}

/** 想被靠近的强度：不是露骨开关，只调语气与主动性。 */
export function desireOf(drives: Drives, intimacy = 0, recentIntimacyHit = 0): number {
  return round(clamp01(0.6 * clamp01(intimacy) + 0.3 * clamp01(drives.longing) + 0.1 * clamp01(recentIntimacyHit)))
}

/** 收到用户回应：快速下降，但留痕；本来就空的状态不许被 floor 抬出新的想念。 */
export function applyUserReply(drives: Drives, mark?: string | number): Drives {
  const reduced = drives.longing * DRIVE_REPLY_KEEP
  const longing = drives.longing <= 0 ? 0 : round(Math.max(DRIVE_TRACE_FLOOR, Math.min(longingCap(1), reduced)))
  return {
    longing,
    desire: round(drives.desire * DRIVE_REPLY_KEEP),
    lastSettledAtMs: drives.lastSettledAtMs,
    ...(markOf(mark) === undefined ? {} : { lastReplyMark: markOf(mark) as string }),
  }
}

/**
 * reducer 与回放共用的单点：先把时间推进掉，再看这一轮是不是回应。
 *
 * `replyMark` 必须是这条用户消息的稳定 id。没有 id 就**不扣**——宁可少扣一次，
 * 也不能拿毫秒当身份，让同一条消息的多个评价各扣一次 0.35。
 */
export function advanceDrives(
  previous: Drives | undefined,
  nowMs: number,
  relationship: Relationship,
  fromInboundUserMessage: boolean,
  options: { horizonMs?: number; intimacy?: number; recentIntimacyHit?: number; asOfMs?: number; replyMark?: string | number } = {},
): Drives {
  const settled = settleDrives(previous, nowMs, relationship.affection, {
    ...options,
    intimacy: options.intimacy ?? relationship.familiarity,
  })
  if (!fromInboundUserMessage) return settled
  const mark = markOf(options.replyMark)
  if (mark === undefined) return settled
  // 同一条用户消息可能产出多个 appraisal：只结算一次，否则 0.35 会被连乘。
  if (settled.lastReplyMark === mark) return settled
  return applyUserReply(settled, mark)
}

export type LongingLevel = 'none' | 'faint' | 'clear' | 'heavy' | 'unbearable'

/** 档位边界与 DRIVE_REPORT_THRESHOLD 同源：0.35 以下不向模型报告。 */
export function longingLevel(longing: number): LongingLevel {
  if (!(longing >= DRIVE_REPORT_THRESHOLD)) return 'none'
  if (longing < 0.55) return 'faint'
  if (longing < 0.75) return 'clear'
  if (longing < 0.9) return 'heavy'
  return 'unbearable'
}

const LEVEL_WORD: Readonly<Record<LongingLevel, string>> = {
  none: '没有起伏',
  faint: '一点点',
  clear: '明显',
  heavy: '很重',
  unbearable: '几乎压不住',
}

/** 语气亲密度上限：desire 越高允许越近，但不许因此变露骨。 */
export function desireClosenessCap(desire: number): number {
  return round(0.5 + 0.4 * clamp01(desire))
}

/**
 * § 表达层注入：只写等级与方向，不写原始数值；低档位返回空串。
 * 硬约束写死在模板里——不直说、不索取、不反复追问、不硬拽话题。
 */
export function renderDriveLine(drives: Drives): string {
  const level = longingLevel(drives.longing)
  const wantsCloseness = drives.desire >= DESIRE_REPORT_THRESHOLD
  if (level === 'none' && !wantsCloseness) return ''
  const parts: string[] = []
  if (level !== 'none') {
    parts.push(`期待${LEVEL_WORD[level]}`)
  }
  if (wantsCloseness) parts.push('想被靠近偏强')
  const constraint = wantsCloseness
    ? '这类状态只许改变语气的亲近程度与主动的意愿，不许直说、不许索取、不许反复追问、不许把话题硬拽到这件事上；是否深入由对方当轮主动决定。'
    : '这类状态只许让语气多一点余温，不许直说、不许索取、不许反复追问、不许把话题硬拽到这件事上。'
  parts.push(constraint)
  return `未了的心事：${parts.join('；')}`
}
