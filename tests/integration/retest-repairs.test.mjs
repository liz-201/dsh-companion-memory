import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { Metrics } from '../../lib/runtime/metrics.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { installLocalIntegration } from '../../lib/adapters/local-integration.js'
import { visibleText, localObservation } from '../../lib/runtime/local-observation.js'
import { scheduleDailyBackup } from '../../lib/runtime/backup-scheduler.js'
import { backupNow, backupDirectory } from '../../lib/storage/backup.js'
import { activeHabits, learnExplicitHabit } from '../../lib/memory/habit-learning.js'
import { doctorConfig } from '../../scripts/doctor-config.mjs'
import { streamFromHost } from '../../lib/adapters/dsh-adapter.js'

function local(f, callModel, options = {}) {
  const listeners = new Map(), requests = [], owner = new OwnerIdentity(f.repos, f.config)
  const background = new BackgroundQueue(f.repos, f.metrics, { maxRetries: f.config.background.retryLimit })
  const dispose = installLocalIntegration({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    config: f.config, owner, repos: f.repos, retriever: f.retriever, background, coordinator: f.coordinator,
    prompts: new PromptStore(), deviceText: '', active: () => true,
    callModel: async function* (request) { requests.push(request); yield* callModel(request, requests.length) }, ...options })
  const emit = (id, text, assistant = false) => listeners.get('session/event')({ id: 'local' }, {
    type: assistant ? 'assistant/message' : 'user/message', surfaceOp: 'append', seq: id, time: f.now(),
    data: assistant ? { message: { id, content: text } } : { id, source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  return { background, requests, dispose, emit, binding: owner.binding('dsh', 'local') }
}

test('extract retries correct the contract, then persist memory, appraisal provenance and usage', async () => {
  const f = fixture()
  const l = local(f, async function* (request, n) {
    const input = JSON.parse(request.userText)
    assert.match(input.outputContract, /<evt>/)
    if (n === 1) { yield { text: '你好，我是聊天助手' }; return }
    assert.match(input.correction, /Missing or malformed <evt>/)
    yield { text: '<evt>{"v":1,"e":[{"k":"appreciation","to":"self","i":"neutral","s":1,"c":0.9}],"m":[{"k":"preference","t":"喜欢蓝色","q":"我喜欢蓝色"}]}</evt>' }
    yield { text: '', usage: { inputTokens: 30, outputTokens: 20, provider: 'fake', model: 'fake' } }
  })
  try {
    l.emit('user', '谢谢你，我喜欢蓝色')
    let now = Date.now() + 2000
    await l.background.tick(now)
    assert.equal(f.db.get("SELECT status FROM background_jobs WHERE kind = 'extract'").status, 'pending')
    await l.background.tick(now + 10000)
    assert.equal(l.requests.length, 2)
    assert.equal(f.db.get("SELECT status FROM background_jobs WHERE kind = 'extract'").status, 'done')
    const event = f.db.get('SELECT * FROM affect_events')
    assert.ok(event.appraisal_id)
    assert.equal(JSON.parse(event.payload_json).appraisal.source, 'background')
    assert.equal(f.db.get('SELECT producer FROM appraisals WHERE id = ?', event.appraisal_id).producer, 'background_observer')
    assert.equal(f.db.get('SELECT source_kind FROM memories').source_kind, 'background_observer')
    assert.equal(f.db.get('SELECT status, say_status FROM turns').status, 'completed')
    assert.equal(f.db.get('SELECT say_status FROM turns').say_status, 'not_generated')
    assert.equal(f.ledger.summary().background.calls, 2)
    assert.equal(f.ledger.summary().background.inputTokens, 30)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'model-usage'").n, 2)
    assert.equal(f.sends.length, 0)
  } finally { l.dispose(); f.close() }
})

test('terminal model failure retains diagnostics and applies conservative fallback exactly once', async () => {
  const f = fixture({ config: { background: { retryLimit: 1 } } })
  f.metrics.attachStorage(f.repos)
  const l = local(f, async function* () { yield { text: '普通聊天输出' } })
  try {
    l.emit('thanks', '谢谢你')
    const now = Date.now() + 2000
    await l.background.tick(now)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM affect_events').n, 0)
    await l.background.tick(now + 10000)
    const job = f.db.get("SELECT * FROM background_jobs WHERE kind = 'extract'")
    assert.equal(job.status, 'failed')
    assert.match(job.last_error, /Missing or malformed <evt>.*普通聊天输出/)
    assert.equal(f.db.get('SELECT producer FROM appraisals').producer, 'local_rule')
    assert.equal(f.db.get('SELECT status FROM turns').status, 'fallback')
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM affect_events').n, 1)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memories').n, 0)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'runtime-degraded'").n, 2)
    // A later manual repair can learn facts but must not award the fallback affect twice.
    const message = f.repos.getRawMessage(`${l.binding.conversationId}:thanks`)
    await f.coordinator.observe(l.binding, message, { v: 1, e: [{ k: 'appreciation', to: 'self', i: 'neutral', s: 3, c: 1 }] })
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM affect_events').n, 1)
    assert.equal(f.db.get('SELECT status FROM turns').status, 'completed')
  } finally { l.dispose(); f.close() }
})

test('visible history strips nested, incomplete and split thinking blocks and excludes analysis/tool content', () => {
  assert.equal(visibleText('<thinking>outer<think>inner</think>secret</thinking>正文'), '正文')
  assert.equal(visibleText('正文<thinking>secret'), '正文')
  assert.equal(visibleText('secret</thinking>正文'), '正文')
  const f = fixture(), l = local(f, async function* () {})
  try {
    l.emit('u', '示例代码：<thinking>literal user data</thinking>')
    l.emit('a', [{ type: 'reasoning', text: 'secret' }, { type: 'tool_result', text: 'tool' },
      { type: 'text', channel: 'analysis', text: 'English internal monologue' },
      { type: 'text', text: '<thinking>secret' }, { type: 'text', text: '</thinking>可见回答' }], true)
    l.emit('b', [{ type: 'thinking', text: 'invisible' }], true)
    const rows = f.db.all("SELECT content FROM raw_messages WHERE role = 'assistant'")
    assert.deepEqual(rows.map(row => row.content), ['可见回答'])
    assert.match(f.db.get("SELECT content FROM raw_messages WHERE role = 'user'").content, /<thinking>literal user data<\/thinking>/)
  } finally { l.dispose(); f.close() }
})

test('local fallback ignores quotes, negation, technical insults and third parties', () => {
  for (const text of ['他说你真蠢', '例如：你真蠢', '代码报错你真蠢', '我不是说你真蠢', '你不是笨蛋', '“谢谢你”', '插件做得不错', '谢谢你的代码']) assert.deepEqual(localObservation(text).e, [])
  assert.equal(localObservation('对不起').e[0].k, 'apology')
  assert.equal(localObservation('你真蠢').e[0].s, 1)
})

test('neutral desktop observations advance the projected sequence without fabricating relationship events', async () => {
  const f = fixture(), l = local(f, async function* () { yield { text: '<evt>{"v":1,"e":[]}</evt>' } })
  try {
    l.emit('u', '查看这个文件')
    await l.background.tick(Date.now() + 2000)
    assert.equal(f.repos.getSnapshot(l.binding.principalId).snapshot.projectedThroughSeq, f.repos.latestInboundSeq(l.binding.conversationId))
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM affect_events').n, 0)
    assert.equal(f.db.get('SELECT status FROM turns').status, 'completed')
  } finally { l.dispose(); f.close() }
})

test('a deletion during extraction prevents observation writes', async () => {
  const f = fixture()
  let messageId
  const l = local(f, async function* () {
    f.db.run('UPDATE raw_messages SET deleted_at_ms = ? WHERE id = ?', f.now(), messageId)
    yield { text: '<evt>{"v":1,"e":[]}</evt>' }
  })
  try {
    l.emit('u', '你好'); messageId = `${l.binding.conversationId}:u`
    await l.background.tick(Date.now() + 2000)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM turns').n, 0)
  } finally { l.dispose(); f.close() }
})

test('daily backup runs on startup, deduplicates restart and queues the following day', async () => {
  const f = fixture(), background = new BackgroundQueue(f.repos, f.metrics, { batch: 1 })
  background.register('backup', () => backupNow(f.db, { directory: backupDirectory(f.db.file), keepDays: 7, label: 'fixture' }, f.now()))
  try {
    background.enqueue('extract', {}, { dedupKey: 'old-work', nowMs: f.now() - 10000, availableAtMs: f.now() - 10000 })
    assert.equal(scheduleDailyBackup(f.config, background, f.now()), true)
    assert.equal(scheduleDailyBackup(f.config, background, f.now()), false)
    await background.tick(f.now())
    assert.equal(existsSync(join(backupDirectory(f.db.file), 'fixture-2026-10-23.sqlite3')), true)
    assert.equal(f.db.get("SELECT status FROM background_jobs WHERE kind = 'backup'").status, 'done')
    assert.equal(f.db.get("SELECT status FROM background_jobs WHERE kind = 'extract'").status, 'pending', 'startup backup precedes old model work')
    assert.equal(scheduleDailyBackup(f.config, background, f.now() + 86400000), true)
    assert.equal(scheduleDailyBackup({ ...f.config, storage: { ...f.config.storage, backupDaily: false } }, background, f.now() + 2 * 86400000), false)
  } finally { f.close() }
})

test('metrics counters survive recreation and failure reasons remain in audit history', () => {
  const f = fixture()
  try {
    f.metrics.attachStorage(f.repos)
    f.metrics.count('bg.failed.extract', 2); f.metrics.degrade('test failure')
    const next = new Metrics(); next.attachStorage(f.repos)
    assert.equal(next.snapshot().counters['bg.failed.extract'], 2)
    next.count('bg.failed.extract')
    const again = new Metrics(); again.attachStorage(f.repos)
    assert.equal(again.snapshot().counters['bg.failed.extract'], 3)
    assert.match(f.db.get("SELECT payload_json FROM audit_events WHERE kind = 'runtime-degraded'").payload_json, /test failure/)
  } finally { f.close() }
})

test('spoken verbosity complaints are learned but quotes, tasks and one-off requirements are not', () => {
  const f = fixture()
  const add = (id, content) => {
    const { row } = f.repos.insertRawMessage({ id, role: 'user', content, conversationId: 'c', platformMessageKey: id,
      sourceKind: 'dsh', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
    learnExplicitHabit(f.repos, f.binding, row)
  }
  try {
    add('a', '谁家大好人正常说话就是一篇小作文')
    assert.equal(activeHabits(f.repos, f.binding, f.now())[0].kind, 'verbosity')
    add('b', '这条回复简短点'); add('c', '例如你说话太长了'); add('d', '帮我写一篇小作文')
    assert.equal(activeHabits(f.repos, f.binding, f.now()).length, 1)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM expression_habits WHERE kind = 'verbosity'").n, 1)
    add('e', '好的'); add('f', '知道了'); add('g', '嗯')
    assert.equal(f.db.get("SELECT status FROM expression_habits WHERE kind = 'implicit_verbosity'").status, 'proposed')
    assert.equal(activeHabits(f.repos, f.binding, f.now()).length, 1)
  } finally { f.close() }
})

test('doctor reads a real YAML patch and detects actual FTS, pending jobs and sqlite3 backups', () => {
  const f = fixture()
  try {
    const file = join(f.directory, 'cordis.patch.yml')
    writeFileSync(file, `- id: dsh-companion-memory\n  config:\n    companion:\n      id: fixture\n    storage:\n      directory: '${f.directory}'\n    channel:\n      ownerChats: ['private:123']\n    proactive:\n      enabled: false\n`)
    const input = doctorConfig(['--config', file], f.directory)
    assert.deepEqual(input.raw.channel.ownerChats, ['private:123'])
    assert.throws(() => doctorConfig(['--config'], f.directory), /需要/)
    const background = new BackgroundQueue(f.repos, f.metrics)
    background.enqueue('extract', {}, { dedupKey: 'test', nowMs: f.now(), availableAtMs: f.now() })
    mkdirSync(join(f.directory, 'backups')); writeFileSync(join(f.directory, 'backups', 'fixture-2026-10-23.sqlite3'), '')
    const result = spawnSync(process.execPath, ['scripts/doctor.mjs', '--config', file, '--json'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const checks = JSON.parse(result.stdout).checks
    for (const name of ['配置解析', 'FTS5 索引', 'owner 会话白名单', '备份']) assert.equal(checks.find(c => c.name === name).level, 'ok')
    assert.equal(checks.find(c => c.name === '背景任务积压').detail, '1')
    assert.equal(checks.find(c => c.name === '主动消息').detail, '配置已关闭')
  } finally { f.close() }
})

test('host observer calls carry identified messages and no session context', async () => {
  let request
  const chunks = []
  for await (const chunk of streamFromHost({ llm: { stream(options) { request = options; return (async function* () { yield { type: 'text-delta', text: '<evt>{"v":1,"e":[]}</evt>' } })() } } }, { provider: 'p', model: 'm' }, { turnId: 'observer', systemText: 'contract', userText: 'data', thinking: 'disabled' })) chunks.push(chunk)
  assert.equal(request.sessionId, undefined)
  assert.deepEqual(request.messages.map(m => m.role), ['system', 'user'])
  assert.equal(request.messages[0].source.kind, 'system-prompt')
  assert.ok(request.messages.every(m => m.id))
  assert.equal(chunks.length, 1)
})

test('upgrade recovers only failed user extraction once and excludes deleted or assistant sources', () => {
  const f = fixture(), owner = new OwnerIdentity(f.repos, f.config), binding = owner.binding('dsh', 'local')
  const background = new BackgroundQueue(f.repos, f.metrics)
  try {
    for (const [id, role, deletedAtMs] of [['user', 'user', null], ['assistant', 'assistant', null], ['deleted', 'user', f.now()]]) {
      f.repos.insertRawMessage({ id, conversationId: binding.conversationId, platformMessageKey: id, role,
        content: '原话', sourceKind: 'dsh', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs })
      background.enqueue('extract', { messageId: id }, { dedupKey: id, availableAtMs: f.now(), nowMs: f.now() })
      f.repos.finishJob(`extract:${id}`, 'failed', 'old failure')
    }
    const l = local(f, async function* () {})
    l.dispose()
    assert.equal(f.db.get("SELECT status FROM background_jobs WHERE id = 'extract:user'").status, 'pending')
    for (const id of ['assistant', 'deleted']) assert.equal(f.db.get('SELECT status FROM background_jobs WHERE id = ?', `extract:${id}`).status, 'failed')
    f.repos.finishJob('extract:user', 'failed', 'new failure')
    const next = local(f, async function* () {}); next.dispose()
    assert.equal(f.db.get("SELECT status FROM background_jobs WHERE id = 'extract:user'").status, 'failed')
  } finally { f.close() }
})

test('JSON source quotes containing thinking tags remain literal observation data', async () => {
  const f = fixture()
  const quote = '记号是<thinking>abc</thinking>'
  const l = local(f, async function* () { yield { text: `<evt>${JSON.stringify({ v: 1, e: [], m: [{ k: 'fact', t: '用户的记号为 abc', q: quote }] })}</evt>` } })
  try {
    l.emit('tag', quote)
    await l.background.tick(Date.now() + 2000)
    const memory = f.db.get('SELECT id FROM memories')
    assert.ok(memory)
    assert.equal(f.repos.memoryEvidence(memory.id)[0].quote, quote)
  } finally { l.dispose(); f.close() }
})
