import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexAppServerClient } from '../../scripts/codex-app-server-client.mjs'
import { CodexMailbox } from '../../scripts/codex-mailbox-store.mjs'
import { runMailboxWorker } from '../../scripts/codex-mailbox-worker.mjs'

async function protocol(t, mode) {
  const client = new CodexAppServerClient(process.execPath, [resolve('tests/fixtures/codex-app-server.mjs'), mode])
  t.after(() => client.close())
  await client.initialize()
  return { client, thread: await client.startThread(process.cwd(), 'test only') }
}

for (const mode of ['normal', 'early']) test(`stdio protocol correlates final responses, including ${mode} notification ordering`, async t => {
  const { client, thread } = await protocol(t, mode)
  const result = await client.run(thread, 'fixture only', { timeoutMs: 2000 })
  assert.equal(result.turnId, 'turn-fixture')
  assert.equal(result.text, '鲸鱼确认：双向处理成功。')
})

for (const [mode, pattern] of [['fail', /TURN_FAILED/], ['rpc-error', /RPC_-32602/], ['exit', /PROCESS_EXITED/], ['hang', /TIMEOUT/], ['empty', /EMPTY_RESPONSE/]]) {
  test(`stdio ${mode} cannot report success or leak a remote error body`, async t => {
    const { client, thread } = await protocol(t, mode)
    await assert.rejects(client.run(thread, 'fixture only', { timeoutMs: 80 }), error => pattern.test(error.message) && !error.message.includes('private-secret'))
  })
}

test('external stop interrupts an in-flight turn instead of supplying fake user answers', async t => {
  const { client, thread } = await protocol(t, 'hang')
  const controller = new AbortController()
  const result = client.run(thread, 'fixture only', { signal: controller.signal, onStarted() { controller.abort() } })
  await assert.rejects(result, /TURN_INTERRUPTED/)
})

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-worker-'))
  const mailboxFile = join(dir, 'box.sqlite3'), stateFile = join(dir, 'worker.json')
  const box = new CodexMailbox(mailboxFile)
  t.after(() => { box.close(); rmSync(dir, { recursive: true, force: true }) })
  const options = { mailboxFile, stateFile, untilMs: Date.now() + 60000, sessionIds: ['session-allowed'], maxTasks: 1, pollMs: 10 }
  return { box, options, stateFile }
}
function fakeClient({ error, calls = [] } = {}) {
  return { async initialize() { calls.push('initialize') }, async startThread() { calls.push('start'); return 'thread-fake' },
    async run(_thread, text, opts) { calls.push(text); opts.onStarted('turn-fake'); if (error) throw error; return { text: '已完成隔离复核。' } }, close() { calls.push('closed') } }
}

test('bounded worker consumes an allowed request and returns the verified final text to the same DSH session', async t => {
  const { box, options } = fixture(t)
  box.enqueue({ id: 'one', sessionId: 'session-allowed', text: '只读核对，不改文件。' })
  const deliveries = []
  const result = await runMailboxWorker({ ...options, clientFactory: () => fakeClient(), dshFactory: async () => ({ send: async (...args) => deliveries.push(args) }) })
  assert.equal(result.state, 'task-limit')
  assert.equal(result.processed, 1)
  assert.equal(result.active, null)
  assert.equal(box.receiver().state, 'offline')
  assert.equal(box.read('one').state, 'response-queued')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0][0], 'session-allowed')
  assert.match(deliveries[0][1], /已完成隔离复核/)
})

test('unlisted sessions receive a refusal without starting a model turn', async t => {
  const { box, options } = fixture(t)
  box.enqueue({ id: 'other', sessionId: 'session-unlisted', text: 'not allowed' })
  const calls = []
  await runMailboxWorker({ ...options, clientFactory: () => fakeClient({ calls }), dshFactory: async () => ({ send: async () => {} }) })
  assert.deepEqual(calls, [], 'Unlisted requests must not even start an app-server process')
  assert.match(box.read('other').response, /白名单/)
})

test('model failures retain pending work and persist an uncertain-turn marker without raw errors', async t => {
  const { box, options, stateFile } = fixture(t)
  box.enqueue({ id: 'one', sessionId: 'session-allowed', text: 'review' })
  await assert.rejects(runMailboxWorker({ ...options, clientFactory: () => fakeClient({ error: Error('CODEX_TURN_FAILED') }), dshFactory: async () => ({ send: async () => {} }) }), /TURN_FAILED/)
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(state.state, 'failed')
  assert.equal(state.active.messageId, 'one')
  assert.equal(box.read('one').state, 'pending')
  assert.equal(box.read('one').response, null)
  let started = false
  await assert.rejects(runMailboxWorker({ ...options, clientFactory: () => { started = true; return fakeClient() } }), /PREVIOUS_TURN_NEEDS_RECONCILIATION/)
  assert.equal(started, false, 'Uncertain admission must not silently launch another model turn')
})

test('DSH outages leave a completed model reply durable for a later delivery retry', async t => {
  const { box, options } = fixture(t)
  box.enqueue({ id: 'one', sessionId: 'session-allowed', text: 'review' })
  await runMailboxWorker({ ...options, clientFactory: () => fakeClient(), dshFactory: async () => { throw Error('offline') } })
  assert.equal(box.read('one').state, 'response-ready')
  await box.deliver({ send: async () => {} })
  assert.equal(box.read('one').state, 'response-queued')
})

test('invalid deadlines, limits and missing explicit session scope never start a model', async t => {
  const { options } = fixture(t)
  for (const over of [{ untilMs: Date.now() - 1 }, { maxTasks: 31 }, { sessionIds: [] }]) {
    await assert.rejects(runMailboxWorker({ ...options, ...over, clientFactory() { assert.fail('must not start') } }))
  }
})

test('a live receiver prevents a competing worker from replacing the active state file', async t => {
  const { box, options, stateFile } = fixture(t)
  const original = { generation: 'existing', state: 'polling' }
  writeFileSync(stateFile, JSON.stringify(original))
  box.heartbeat('other-receiver')
  await assert.rejects(runMailboxWorker({ ...options, clientFactory() { assert.fail('must not start') } }), /WORKER_START_OR_RUNTIME_FAILED/)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), original)
})

test('generation-scoped stop interrupts active work, keeps it pending and releases the receiver', async t => {
  const { box, options, stateFile } = fixture(t)
  box.enqueue({ id: 'one', sessionId: 'session-allowed', text: 'review' })
  const client = fakeClient()
  client.run = async (_thread, _text, opts) => {
    opts.onStarted('turn-waiting')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    writeFileSync(`${stateFile}.stop`, JSON.stringify({ generation: state.generation }))
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Error('CODEX_TURN_INTERRUPTED')), { once: true }))
  }
  const state = await runMailboxWorker({ ...options, clientFactory: () => client, dshFactory: async () => ({ send: async () => {} }) })
  assert.equal(state.state, 'stopped')
  assert.equal(state.processed, 0)
  assert.equal(box.read('one').state, 'pending')
  assert.equal(box.receiver().state, 'offline')
})

test('each allowed message gets a fresh app-server lifecycle', async t => {
  const { box, options } = fixture(t)
  box.enqueue({ id: 'one', sessionId: 'session-allowed', text: 'first' })
  box.enqueue({ id: 'two', sessionId: 'session-allowed', text: 'second' })
  const calls = []
  const state = await runMailboxWorker({ ...options, maxTasks: 2, clientFactory: () => fakeClient({ calls }), dshFactory: async () => ({ send: async () => {} }) })
  assert.equal(state.processed, 2)
  assert.equal(calls.filter(x => x === 'initialize').length, 2)
  assert.equal(calls.filter(x => x === 'closed').length, 2)
})

test('an idle worker reaches its deadline without launching a model process', async t => {
  const { box, options } = fixture(t)
  const state = await runMailboxWorker({ ...options, untilMs: Date.now() + 60, clientFactory() { assert.fail('idle must not start a model') }, dshFactory: async () => ({ send: async () => {} }) })
  assert.equal(state.state, 'deadline')
  assert.equal(box.receiver().state, 'offline')
})
