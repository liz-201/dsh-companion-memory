import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, insult, appreciation } from '../helpers/fixture.mjs'
import { StreamParser } from '../../lib/runtime/stream-parser.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { estimateTokens } from '../../lib/runtime/context-budget.js'
import { ProactiveScheduler } from '../../lib/proactive/scheduler.js'
import { OutboxWorker } from '../../lib/proactive/outbox-worker.js'

test('感谢事件在没有冲突 episode 时正常持久化', async t => {
  const f = fixture({ events: [appreciation] }); t.after(() => f.close())
  const result = await f.turn('谢谢你')
  assert.equal(result.evtApplied, true, result.problems.join(','))
  assert.equal(f.repos.activeAffectEvents('p').length, 1)
  assert.equal(f.repos.activeAffectEvents('p')[0].episode_id, null)
  assert.ok(f.snapshot().relationship.trust > 0.5)
})

test('每日绝对变化额度在多次独立争执间累计', async t => {
  const f = fixture({ events: Array.from({ length: 20 }, () => insult) }); t.after(() => f.close())
  for (let i = 0; i < 20; i++) { await f.turn(); f.advance(20 * 60_000) }
  assert.ok(f.snapshot().relationship.trust >= 0.35)
  assert.ok(f.snapshot().relationship.affection >= 0.03)
  assert.ok(f.snapshot().relationship.grievance <= 0.25)
})

test('更正只移除指定事件，重放后仍保留其他事件的影响', async t => {
  const f = fixture({ events: [insult, insult] }); t.after(() => f.close())
  await f.turn(); f.advance(20 * 60_000); await f.turn()
  const first = f.repos.activeAffectEvents('p')[0]
  assert.equal(f.command(`correct ${first.seq} 归因错误`).kind, 'success')
  assert.equal(f.repos.activeAffectEvents('p').length, 1)
  assert.equal(f.snapshot().relationship.trust, 0.49)
  assert.equal(f.repos.listEpisodes('p', ['open', 'repairing'], 20).length, 1)
})

test('事件与 episode 在快照写入失败时整体回滚', async t => {
  const f = fixture({ events: [insult] }); t.after(() => f.close())
  const put = f.repos.putSnapshot.bind(f.repos)
  let writes = 0
  f.repos.putSnapshot = (...args) => { if (++writes === 2) throw new Error('injected write failure'); return put(...args) }
  const result = await f.turn()
  assert.ok(result.problems.some(item => item.includes('injected write failure')))
  assert.equal(f.repos.activeAffectEvents('p').length, 0)
  assert.equal(f.repos.listEpisodes('p', ['open', 'repairing'], 20).length, 0)
  assert.equal(f.snapshot().relationship.trust, 0.5)
})

test('完整请求包含当前消息，超长输入保留原文且不调用模型', async t => {
  const f = fixture(); t.after(() => f.close())
  const result = await f.turn('鱼'.repeat(6000))
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'input-budget-exceeded')
  assert.equal(f.requests.length, 0)
  assert.equal(f.repos.recentRawMessages('c', 5)[0].content.length, 6000)
})

test('预算报告覆盖实际发送给模型的 system 和 user 字符串', async t => {
  const f = fixture(); t.after(() => f.close())
  const result = await f.turn('鱼'.repeat(800))
  assert.equal(f.requests.length, 1)
  const request = f.requests[0]
  const reported = Number(/tokens=(\d+)/.exec(result.budget)[1])
  assert.equal(reported, estimateTokens(request.systemText) + estimateTokens(request.userText) + 12)
})

test('正文闭合后立即发送，发送前 outbox 已持久化且只发一次', async t => {
  let f
  f = fixture({ callModel: async function* () {
    yield { text: '<say>你好</say>' }
    assert.equal(f.sends.length, 1, '正文必须早于尾部发送')
    assert.equal(f.db.get("SELECT status FROM outbox WHERE turn_id IS NOT NULL").status, 'sent')
    yield { text: '<evt>{"v":1,"e":[]}</evt>' }
  } }); t.after(() => f.close())
  await f.turn()
  assert.equal(f.sends.length, 1)
  assert.equal(f.repos.counts().outbox, 1)
})

test('尾部断流保留已发送正文与原始证据，不重发', async t => {
  const f = fixture({ callModel: async function* () { yield { text: '<say>你好</say>' }; throw new Error('tail disconnected') } }); t.after(() => f.close())
  const result = await f.turn()
  assert.equal(f.sends.length, 1)
  assert.equal(result.say, '你好')
  assert.ok(result.problems.includes('model-failed'))
  assert.equal(f.db.get('SELECT tail_status FROM turns').tail_status, 'pending')
})

test('未闭合正文与疑似协议包装不得原样回退发送', async t => {
  const f = fixture({ callModel: async function* () { yield { text: '<say>正文未闭合<evt>{"private":123}' } } }); t.after(() => f.close())
  await f.turn()
  assert.equal(f.sends.length, 0)
})

test('evt 字符串包含字面闭合标签时支持逐字符切分', () => {
  const raw = JSON.stringify({ v: 1, e: [], m: [{ k: 'fact', t: '字面标签', q: '解释 </evt> 与 "引号"' }] })
  const parser = new StreamParser()
  for (const char of `<say>你好</say><evt>${raw}</evt>`) parser.feed(char)
  const result = parser.finish().result
  assert.equal(result.evtRaw, raw)
  assert.deepEqual(result.problems, [])
})

test('人格提示缓存按预设隔离', () => {
  const prompts = new PromptStore()
  assert.notEqual(prompts.load('irritable').persona, prompts.load('gentle').persona)
})

test('提醒校验失败先提交失败结果，随后回复且不误称已设置', async t => {
  const f = fixture({ callModel: async function* () {
    yield { text: '<say>已经设置好了</say>' }
    assert.equal(f.sends.length, 0)
    yield { text: '<evt>{"v":1,"e":[],"t":[{"k":"reminder","text":"测试","when":"2026-10-23T12:00:00+08:00","q":"不存在的原文"}]}</evt>' }
  } }); t.after(() => f.close())
  const result = await f.turn('今天十二点提醒我测试')
  assert.equal(f.repos.counts().tasks, 0)
  assert.ok(result.problems.includes('operation-not-committed'))
  assert.ok(!f.sends[0].text.includes('已经设置好了'))
})

function addReminder(f) {
  f.repos.insertTask({ id: 'reminder', principalId: 'p', conversationId: 'c', sourceMessageId: null, kind: 'reminder', content: '测试提醒', status: 'confirmed', dueAtMs: f.now() - 1000, timezone: 'Asia/Shanghai', expiresAtMs: f.now() + 3600_000, createdAtMs: f.now() })
}

test('关闭自发联系且闲聊额度为零，确认提醒仍能入队并送达', async t => {
  const f = fixture({ config: { proactive: { enabled: false, spontaneousLimitPerDay: 0, maxGenerationCallsPerCandidate: 0 } } }); t.after(() => f.close())
  addReminder(f)
  const scheduler = new ProactiveScheduler({ config: f.config, repos: f.repos, metrics: f.metrics, listConversations: () => [{ conversationId: 'c', principalId: 'p' }], generate: async () => { throw new Error('提醒不应调用模型') } })
  assert.equal((await scheduler.scan(f.now())).enqueued, 1)
  let sends = 0
  const worker = new OutboxWorker({ config: f.config, repos: f.repos, metrics: f.metrics, chatForConversation: () => 'private:123', transport: { sendText: async () => { sends++; return { kind: 'accepted', atMs: f.now() } } } })
  assert.equal((await worker.runOnce(f.now()))[0].status, 'sent')
  assert.equal(sends, 1)
  assert.equal(f.repos.dueTasks(f.now()).length, 0)
  assert.equal(f.repos.countOutboxSince('c', 0), 0, '提醒不消耗闲聊额度')
})

test('平台 unknown 回执留存，后续扫描不自动重发', async t => {
  const f = fixture(); t.after(() => f.close()); addReminder(f)
  const scheduler = new ProactiveScheduler({ config: f.config, repos: f.repos, metrics: f.metrics, listConversations: () => [{ conversationId: 'c', principalId: 'p' }], generate: async () => null })
  await scheduler.scan(f.now())
  let sends = 0
  const worker = new OutboxWorker({ config: f.config, repos: f.repos, metrics: f.metrics, chatForConversation: () => 'private:123', transport: { sendText: async () => { sends++; return { kind: 'unknown', atMs: f.now() } } } })
  assert.equal((await worker.runOnce(f.now()))[0].status, 'unknown')
  await worker.runOnce(f.now()); await scheduler.scan(f.now()); await worker.runOnce(f.now())
  assert.equal(sends, 1)
})
