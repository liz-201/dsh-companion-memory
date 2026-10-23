import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractReminderSubject,
  formatInZone,
  looksLikeReminderRequest,
  parseSmallNumber,
  parseWhen,
  partsInZone,
  zoneOffsetMs,
  zonedToUtc,
} from '../../lib/domain/time-parse.js'

// 2025-10-09 15:30 北京时间
const NOW = zonedToUtc(2025, 10, 9, 15, 30, 'Asia/Shanghai')
const TZ = 'Asia/Shanghai'

function when(text, nowMs = NOW) {
  return parseWhen(text, { nowMs, timezone: TZ })
}

test('时区换算：东八区偏移固定为 +8h', () => {
  assert.equal(zoneOffsetMs(NOW, TZ), 8 * 60 * 60_000)
  const parts = partsInZone(NOW, TZ)
  assert.equal(parts.hour, 15)
  assert.equal(parts.minute, 30)
  assert.equal(parts.weekday, 4) // 2025-10-09 是周四
})

test('「明天八点」按用户时区落在次日 08:00', () => {
  const result = when('明天八点')
  assert.equal(result.ok, true)
  const parts = partsInZone(result.atMs, TZ)
  assert.equal(parts.day, 10)
  assert.equal(parts.hour, 8)
  assert.equal(parts.minute, 0)
  assert.ok(result.atMs > NOW)
})

test('「今晚十一点」落在当天 23:00', () => {
  const result = when('今晚十一点')
  assert.equal(result.ok, true)
  const parts = partsInZone(result.atMs, TZ)
  assert.equal(parts.day, 9)
  assert.equal(parts.hour, 23)
})

test('「今天八点」已过 → past，绝不悄悄挪到明天', () => {
  const result = when('今天八点')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'past')
})

test('没有时刻信息 → missing-time', () => {
  const result = when('明天')
  assert.equal(result.ok, false)
  assert.ok(['missing-time', 'invalid', 'unsupported'].includes(result.reason), result.reason)
})

test('无法理解的说法 → 明确失败而不是猜一个时间', () => {
  const result = when('找个良辰吉日')
  assert.equal(result.ok, false)
  assert.ok(['unsupported', 'invalid', 'missing-time'].includes(result.reason), result.reason)
})

test('中文数字解析', () => {
  assert.equal(parseSmallNumber('八'), 8)
  assert.equal(parseSmallNumber('十五'), 15)
  assert.equal(parseSmallNumber('二十三'), 23)
  assert.equal(parseSmallNumber('7'), 7)
  assert.equal(parseSmallNumber('瞎写'), null)
})

test('提醒识别：明确请求才当提醒，普通叙述不当提醒', () => {
  assert.equal(looksLikeReminderRequest('明天提醒我交报告'), true)
  assert.equal(looksLikeReminderRequest('今天好累'), false)
})

test('提醒正文抽取会去掉时间与提醒动词', () => {
  const subject = extractReminderSubject('明天八点提醒我交报告')
  assert.ok(subject.includes('交报告'), subject)
})

test('formatInZone 输出可读墙钟时间', () => {
  const text = formatInZone(NOW, TZ)
  assert.match(text, /2025-10-09/)
  assert.match(text, /15:30/)
})

test('zonedToUtc 处理夏令时跳变间隙（不存在的 02:30 被推到有效时刻）', () => {
  const utc = zonedToUtc(2025, 3, 9, 2, 30, 'America/New_York')
  const parts = partsInZone(utc, 'America/New_York')
  assert.notEqual(parts.hour, 2) // 该墙钟时间不存在
  assert.equal(parts.minute, 30)
})
