import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMITS,
  PROTOCOL_VERSION,
  findRootObjectEnd,
  parseEvt,
  renderReply,
  toHistoryEntry,
  validateEvt,
} from '../../lib/runtime/output-protocol.js'
import {
  StreamParser,
  decodeSayText,
  encodeSayText,
  parseComplete,
} from '../../lib/runtime/stream-parser.js'

const goodEvent = { k: 'insult', to: 'self', i: 'hostile', s: 2, c: 0.9 }

test('合法 evt 通过校验', () => {
  const result = validateEvt({ v: PROTOCOL_VERSION, e: [goodEvent] })
  assert.equal(result.ok, true)
  assert.equal(result.payload.e.length, 1)
})

test('版本不符 → bad-version', () => {
  const result = validateEvt({ v: 2, e: [goodEvent] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.includes('bad-version'))
})

test('未知事件类型 → bad-event-field', () => {
  const result = validateEvt({ v: 1, e: [{ ...goodEvent, k: 'banish' }] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.includes('bad-event-field'))
})

test('severity 越界 / confidence 越界都被拒', () => {
  assert.equal(validateEvt({ v: 1, e: [{ ...goodEvent, s: 9 }] }).ok, false)
  assert.equal(validateEvt({ v: 1, e: [{ ...goodEvent, c: 1.7 }] }).ok, false)
})

test(`事件条数超过 ${LIMITS.events} → 只保留前 ${LIMITS.events} 条并记 warning`, () => {
  const events = Array.from({ length: LIMITS.events + 1 }, () => goodEvent)
  const result = validateEvt({ v: 1, e: events })
  assert.equal(result.ok, true)
  assert.equal(result.payload.e.length, LIMITS.events)
  assert.ok(result.warnings.some((text) => text.includes('超上限')), result.warnings.join('|'))
})

test('模型越权带归属字段：剔除并记 warning，不整条拒绝', () => {
  const result = validateEvt({ v: 1, e: [{ ...goodEvent, srcMessageId: 'm-1' }] })
  assert.equal(result.ok, true)
  assert.ok(
    result.warnings.some((text) => text.includes('srcMessageId')),
    JSON.stringify(result.warnings),
  )
  assert.equal('srcMessageId' in result.payload.e[0], false)
})

test('超字节上限 → oversize', () => {
  const result = validateEvt({ v: 1, e: [goodEvent], m: [{ k: 'fact', t: 'x'.repeat(100), q: 'y'.repeat(100) }] }, LIMITS.evtHardBytes + 1)
  assert.equal(result.ok, false)
  assert.ok(result.problems.includes('oversize'))
})

test('畸形 JSON 明确失败，不静默当成空 evt', () => {
  const result = parseEvt('{"v":1,"e":[')
  assert.equal(result.ok, false)
})

test('evt 永不进入用户可见正文', () => {
  assert.equal(renderReply('我在。'), '我在。')
  assert.equal(toHistoryEntry({ say: '我在。', evtApplied: true }), '我在。')
})

test('findRootObjectEnd 只认真正的根对象闭合（字符串里的花括号不算）', () => {
  const text = '{"v":1,"e":[{"k":"teasing","q":"他说 } 这样"}]}'
  assert.equal(findRootObjectEnd(text), text.length)
  assert.equal(findRootObjectEnd('{"v":1,"e":['), null)
})

test('say 转义：正文里的尖括号与 & 解码一次可逆', () => {
  const raw = '这行代码是 <evt> 和 a & b'
  assert.equal(decodeSayText(encodeSayText(raw)), raw)
})

test('流式解析：分片跨边界也能拼出完整 say', () => {
  const parser = new StreamParser()
  const chunks = ['<sa', 'y>你', '好</s', 'ay>']
  const events = chunks.flatMap((chunk) => parser.feed(chunk))
  const { result } = parser.finish()
  assert.equal(result.say, '你好')
  assert.ok(events.some((event) => event.type === 'say-closed'))
  assert.equal(result.state, 'DONE')
})

test('流式解析：say 之后无 evt 属正常结束', () => {
  const result = parseComplete('<say>嗯。</say>')
  assert.equal(result.say, '嗯。')
  assert.equal(result.evtRaw, null)
  assert.equal(result.state, 'DONE')
})

test('流式解析：半截 evt 不当作有效记录', () => {
  const result = parseComplete('<say>好</say><evt>{"v":1,"e":[')
  assert.equal(result.say, '好')
  assert.equal(result.evtRaw, null)
  assert.ok(result.problems.includes('evt-unclosed'), result.problems.join(','))
})

test('流式解析：重复 say 被识别为模仿协议', () => {
  const result = parseComplete('<say>一</say><say>二</say>')
  assert.equal(result.duplicateSay, true)
  assert.ok(result.problems.includes('duplicate-say'))
})

test('没有 say 包装 → 判为协议外文本', () => {
  const result = parseComplete('直接说话没有包装')
  assert.equal(result.say, null)
  assert.ok(result.problems.includes('text-before-say'), result.problems.join(','))
})

test('流式解析：say 未闭合时保留已收到正文（由调用方决定是否发送）', () => {
  const result = parseComplete('<say>说到一半')
  assert.equal(result.say, '说到一半')
  assert.ok(result.problems.includes('say-unclosed'))
})
