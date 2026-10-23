/**
 * 用户时区下的自然语言时间解析（任务书 §14.3、§27.3）。
 *
 * 三条硬规矩，测试逐条断言：
 *   1. 一律按**用户时区**解释，绝不按服务器本地时区猜。
 *   2. 缺时间、含糊、超出支持范围 → 明确失败（调用方建 proposed），不编一个时间。
 *   3. 「今天八点」若已过去 → 返回 past，让模型/命令**确认意图**，
 *      绝不悄悄挪到明天。
 *
 * 不引第三方库：只用 Intl 做时区换算，避免多一个依赖与时区数据库漂移。
 */

export interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0=周日，6=周六（与 Date.getDay 一致）。 */
  weekday: number
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timezone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsCache.set(timezone, fmt)
  }
  return fmt
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** 把绝对时刻换算成某个时区的墙钟时间。 */
export function partsInZone(ms: number, timezone: string): ZoneParts {
  const parts = formatter(timezone).formatToParts(new Date(ms))
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0'
  const hourRaw = pick('hour')
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    // en-US + hour12:false 在部分 ICU 版本会把 24:00 写成 "24"。
    hour: Number(hourRaw) % 24,
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0,
  }
}

/** 该时刻在指定时区的 UTC 偏移（毫秒，东八区为 +8h）。 */
export function zoneOffsetMs(ms: number, timezone: string): number {
  const p = partsInZone(ms, timezone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * 墙钟时间 → 绝对时刻。
 * 用两次迭代收敛，兼容有夏令时的时区；不存在的墙钟时间（跳变间隙）
 * 会被推到跳变后的第一个有效时刻，并在调用方用 partsInZone 复核。
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  let offset = zoneOffsetMs(guess, timezone)
  let candidate = guess - offset
  const offset2 = zoneOffsetMs(candidate, timezone)
  if (offset2 !== offset) {
    offset = offset2
    candidate = guess - offset
  }
  return candidate
}

export function formatInZone(ms: number, timezone: string): string {
  const p = partsInZone(ms, timezone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/** 解析 0–59 的中文/阿拉伯数字（「八」「十五」「二十三」「8」）。 */
export function parseSmallNumber(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const ascii = /^\d{1,3}$/.exec(trimmed)
  if (ascii !== null) return Number(trimmed)
  if (trimmed === '十') return 10
  const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(trimmed)
  if (ten !== null) {
    const tens = ten[1] === undefined ? 1 : (CN_DIGITS[ten[1]] ?? 0)
    const ones = ten[2] === undefined ? 0 : (CN_DIGITS[ten[2]] ?? 0)
    return tens * 10 + ones
  }
  if (trimmed.length === 1) return CN_DIGITS[trimmed] ?? null
  return null
}

export type WhenFailure = 'missing-time' | 'past' | 'ambiguous' | 'unsupported' | 'invalid'

export interface WhenParseOk {
  ok: true
  atMs: number
  /** 解析依据的墙钟时间，供日志与「为什么这么理解」展示。 */
  wallClock: string
  /** 是否只给了日期没给时刻（调用方应视作缺时间）。 */
  hasTime: true
  matched: string
}

export interface WhenParseFail {
  ok: false
  reason: WhenFailure
  detail: string
  matched?: string
}

export type WhenParse = WhenParseOk | WhenParseFail

interface DayOffset {
  year: number
  month: number
  day: number
  /** 相对「今天」的天数偏移，仅用于诊断。 */
  offset: number
}

function addDays(base: ZoneParts, days: number): DayOffset {
  const utc = Date.UTC(base.year, base.month - 1, base.day) + days * 86_400_000
  const d = new Date(utc)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), offset: days }
}


const WEEKDAY_WORDS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 0,
}

export interface ParseWhenOptions {
  nowMs: number
  timezone: string
  /** 用户原话；用于交叉校验（模型给的 when 必须与本句一致）。 */
  text?: string
}

const TIME_RE = /(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[:：点时]\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,2})?\s*(分|半)?/
const RELATIVE_RE = /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(个)?\s*(小时|钟头|分钟|分|天|周|星期)\s*(后|以后|之后)/
const HALF_HOUR_RE = /半\s*(个)?\s*(小时|钟头)\s*(后|以后|之后)/
const DATE_CN_RE = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

/** 从一段中文里抽取「哪天」。返回 null 表示没提到日期（默认今天）。 */
function resolveDay(text: string, now: ZoneParts): DayOffset | { error: WhenFailure; detail: string } {
  if (/大后天/.test(text)) return addDays(now, 3)
  if (/后天/.test(text)) return addDays(now, 2)
  if (/(明天|明日|明儿)/.test(text)) return addDays(now, 1)
  if (/(今天|今日|今儿|今晚)/.test(text)) return { year: now.year, month: now.month, day: now.day, offset: 0 }

  const dateMatch = DATE_CN_RE.exec(text)
  if (dateMatch !== null) {
    const month = parseSmallNumber(dateMatch[1] ?? '')
    const day = parseSmallNumber(dateMatch[2] ?? '')
    if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) {
      return { error: 'invalid', detail: `无法识别的日期：${dateMatch[0]}` }
    }
    let year = now.year
    const guess = Date.UTC(year, month - 1, day)
    // 跨年：说「1月3日」而当前是 12 月 → 指明年。
    if (guess < Date.UTC(now.year, now.month - 1, now.day) - 200 * 86_400_000) year += 1
    const d = new Date(Date.UTC(year, month - 1, day))
    if (d.getUTCMonth() + 1 !== month) return { error: 'invalid', detail: `不存在的日期：${dateMatch[0]}` }
    return { year, month, day, offset: 0 }
  }

  const weekMatch = /(下周|下星期|这周|这星期|本周|周|星期)([一二三四五六日天1-7])/.exec(text)
  if (weekMatch !== null) {
    const target = WEEKDAY_WORDS[weekMatch[2] ?? '']
    if (target === undefined) return { error: 'invalid', detail: `无法识别的星期：${weekMatch[0]}` }
    const descriptor = weekMatch[1] ?? ''
    let delta = (target - now.weekday + 7) % 7
    if (descriptor.startsWith('下')) {
      // 「下周三」= 下一个自然周的周三。
      const toNextMonday = ((1 - now.weekday + 7) % 7) || 7
      delta = toNextMonday + ((target - 1 + 7) % 7)
    } else if (descriptor.startsWith('这') || descriptor.startsWith('本')) {
      delta = (target - now.weekday + 7) % 7
    } else if (delta === 0) {
      // 只说「周三」而今天就是周三：指下周，避免立刻过期。
      delta = 7
    }
    return addDays(now, delta)
  }
  return { year: now.year, month: now.month, day: now.day, offset: 0 }
}


function applyPeriod(text: string, hour: number): number {
  const afternoon = /(下午|傍晚|晚上|夜里|今晚|中午)/.test(text)
  const morning = /(凌晨|早上|早晨|清晨|上午)/.test(text)
  if (morning) return hour === 12 ? 0 : hour % 12 === 0 ? 0 : hour
  if (afternoon) {
    if (hour === 12) return 12
    if (hour > 12) return hour
    return hour + 12
  }
  return hour
}

/**
 * 解析用户原话里的时间。
 * 输入可以是纯 ISO 字符串（模型产物校验路径），也可以是中文自然语言。
 */
export function parseWhen(input: string, options: ParseWhenOptions): WhenParse {
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'missing-time', detail: '没有提到时间' }
  const now = partsInZone(options.nowMs, options.timezone)

  if (ISO_RE.test(text)) {
    const atMs = Date.parse(text.replace(' ', 'T'))
    if (Number.isNaN(atMs)) return { ok: false, reason: 'invalid', detail: `不是合法时间：${text}` }
    if (atMs <= options.nowMs) return { ok: false, reason: 'past', detail: `${text} 已经过去`, matched: text }

    return {
      ok: true,
      atMs,
      wallClock: formatInZone(atMs, options.timezone),
      hasTime: true,
      matched: text,
    }
  }

  if (HALF_HOUR_RE.test(text)) {
    const atMs = options.nowMs + 30 * 60_000
    return { ok: true, atMs, wallClock: formatInZone(atMs, options.timezone), hasTime: true, matched: '半小时后' }
  }

  const relative = RELATIVE_RE.exec(text)
  if (relative !== null) {
    const amount = parseSmallNumber(relative[1] ?? '')
    if (amount === null) return { ok: false, reason: 'invalid', detail: `无法识别的时长：${relative[0]}` }
    const unit = relative[3] ?? ''
    const unitMs = unit === '分钟' || unit === '分' ? 60_000 : unit === '天' ? 86_400_000 : unit === '周' || unit === '星期' ? 7 * 86_400_000 : 3_600_000
    const atMs = options.nowMs + amount * unitMs
    return { ok: true, atMs, wallClock: formatInZone(atMs, options.timezone), hasTime: true, matched: relative[0] }
  }

  const day = resolveDay(text, now)
  if ('error' in day) return { ok: false, reason: day.error, detail: day.detail }

  const timeMatch = TIME_RE.exec(text)
  if (timeMatch === null) {
    const hasDayWord = /(明天|后天|大后天|今天|周|星期|月)/.test(text)
    if (hasDayWord) return { ok: false, reason: 'missing-time', detail: '只说了日期，没说几点' }
    return { ok: false, reason: 'missing-time', detail: '没有可识别的时间' }
  }

  const rawHour = parseSmallNumber(timeMatch[1] ?? '')
  if (rawHour === null) return { ok: false, reason: 'invalid', detail: `无法识别的时刻：${timeMatch[0]}` }
  let minute = 0
  if (timeMatch[3] === '半') minute = 30
  else if (timeMatch[2] !== undefined) {
    const parsed = parseSmallNumber(timeMatch[2])
    if (parsed === null) return { ok: false, reason: 'invalid', detail: `无法识别的分钟：${timeMatch[0]}` }
    minute = parsed
  }
  if (minute > 59) return { ok: false, reason: 'invalid', detail: `分钟越界：${timeMatch[0]}` }

  const hour = applyPeriod(text, rawHour)
  if (hour > 23) return { ok: false, reason: 'invalid', detail: `小时越界：${timeMatch[0]}` }

  const atMs = zonedToUtc(day.year, day.month, day.day, hour, minute, options.timezone)
  const wall = formatInZone(atMs, options.timezone)
  if (atMs <= options.nowMs) {
    return {
      ok: false,
      reason: 'past',
      detail: `${wall}（用户时区 ${options.timezone}）已经过去，需要确认是明天还是别的时刻`,
      matched: timeMatch[0],
    }
  }
  return { ok: true, atMs, wallClock: wall, hasTime: true, matched: timeMatch[0] }
}

/**
 * 提醒请求识别：用户这句话是不是在让助手在某个时刻提醒某事。
 * 只做**保守**判定：没有「提醒/叫我/别忘了」这类明确祈使就返回 false。
 */
export function looksLikeReminderRequest(text: string): boolean {
  return /(提醒我|提醒一下|叫我|喊我|通知我|别忘|不要忘|记得提醒)/.test(text)
}

/** 从「今晚八点提醒我测试连接」里剥出要做的事；剥不出就返回 null（走 proposed）。 */
export function extractReminderSubject(text: string): string | null {
  const cleaned = text
    .replace(/^(那|嗯|好|行|ok|OK)?[，,。\s]*/u, '')
    .replace(/(提醒我|提醒一下|叫我|喊我|通知我|别忘(了)?|不要忘(了)?|记得提醒)/g, '')
    .replace(/(今天|明天|后天|大后天|今晚|明早|下午|上午|晚上|中午|凌晨|早上)/g, '')
    .replace(/\d{1,2}\s*[:：点时]\s*(\d{1,2})?\s*(分|半)?/g, '')
    .replace(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(个)?\s*(小时|钟头|分钟|分|天|周|星期)\s*(后|以后|之后)/g, '')
    .replace(/(下周|下星期|这周|本周|周|星期)[一二三四五六日天1-7]/g, '')
    .replace(/[，,。！!？?~～\s]+/g, ' ')
    .trim()
  if (cleaned.length < 1 || cleaned.length > 60) return null
  if (!/[\u3400-\u9fffA-Za-z0-9]/.test(cleaned)) return null
  return cleaned
}
