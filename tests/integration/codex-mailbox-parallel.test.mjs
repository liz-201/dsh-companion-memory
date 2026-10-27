import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexMailbox } from '../../scripts/codex-mailbox-store.mjs'
import { runMailboxWorker } from '../../scripts/codex-mailbox-worker.mjs'
import { createReviewWorkspace } from '../../scripts/codex-review-workspace.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`)
    await delay(5)
  }
}

async function hold(gate, signal) {
  let abort
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(Object.assign(Error('CODEX_TURN_INTERRUPTED'), { terminal: true }))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try { await Promise.race([gate.promise, interrupted]) }
  finally { signal.removeEventListener('abort', abort) }
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-parallel-'))
  const cwd = join(dir, 'source')
  mkdirSync(cwd)
  const mailboxFile = join(dir, 'box.sqlite3'), stateFile = join(dir, 'worker.json')
  const box = new CodexMailbox(mailboxFile)
  const jobs = [], gates = [], workspaces = [], calls = []
  let nextTimestamp = 1000
  const options = {
    cwd, mailboxFile, stateFile, untilMs: Date.now() + 8000,
    sessionIds: ['session-allowed'], maxTasks: 1, pollMs: 5, concurrency: 3,
    dshFactory: async () => ({ send: async () => {} }),
    reviewWorkspaceFactory: async (sourceRoot, { id }) => {
      const reviewCwd = join(dir, `review-${id}`)
      mkdirSync(reviewCwd)
      const manifestFile = join(reviewCwd, 'manifest.json')
      writeFileSync(manifestFile, JSON.stringify({ sourceRoot, files: [] }))
      const workspace = { cwd: reviewCwd, sourceRoot, manifestFile, files: [] }
      workspaces.push(workspace)
      return workspace
    },
  }
  const gate = () => { const value = deferred(); gates.push(value); return value }
  const enqueue = (id, kind) => box.enqueue({ id, sessionId: 'session-allowed', text: `fixture ${id}`, ...(kind ? { kind } : {}) }, nextTimestamp++)
  const factory = handler => (message, context) => {
    const call = { id: message.id, kind: message.kind, context, closed: false }
    calls.push(call)
    return {
      async initialize() {},
      async startThread(threadCwd, instructions, settings) {
        Object.assign(call, { cwd: threadCwd, instructions, settings })
        return `thread-${message.id}`
      },
      async run(threadId, _text, turnOptions) {
        call.threadId = threadId
        turnOptions.onStarted(`turn-${message.id}`)
        return handler(message, turnOptions, call)
      },
      close() { call.closed = true },
    }
  }
  const run = over => {
    const job = runMailboxWorker({ ...options, ...over })
    // Keep failures handled while a test waits for a controlled task to start.
    job.catch(() => {})
    jobs.push(job)
    return job
  }
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const stop = () => writeFileSync(`${stateFile}.stop`, JSON.stringify({ generation: readState().generation }))
  t.after(async () => {
    for (const value of gates) value.resolve()
    try { stop() } catch {}
    await Promise.allSettled(jobs)
    box.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { box, cwd, stateFile, calls, workspaces, options, gate, enqueue, factory, run, readState, stop }
}

test('mailbox task kinds survive persistence and default to write without accepting unknown execution modes', t => {
  const f = fixture(t)
  f.enqueue('default')
  f.enqueue('chat', 'chat')
  f.enqueue('review', 'review')
  assert.equal(f.box.read('default').kind, 'write')
  assert.equal(f.box.read('chat').kind, 'chat')
  assert.equal(f.box.read('review').kind, 'review')
  assert.throws(() => f.enqueue('unknown', 'shell'))
})

test('mailbox schema one migrates without changing queued messages, replies or stable delivery identities', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mailbox-v1-'))
  const file = join(dir, 'legacy.sqlite3')
  let box
  t.after(() => { box?.close(); rmSync(dir, { recursive: true, force: true }) })
  const legacy = new DatabaseSync(file)
  let originalRows, originalReceiver
  try {
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, consumer TEXT, lease_until_ms INTEGER,
        response TEXT, responded_at_ms INTEGER, delivery_request_id TEXT NOT NULL UNIQUE,
        delivered_at_ms INTEGER
      );
      CREATE TABLE receiver (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), consumer TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
      );
      INSERT INTO receiver VALUES (1,'legacy-consumer',2000,5000);
      PRAGMA user_version=1;
    `)
    const insert = legacy.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)')
    insert.run('pending', 'session-legacy', '旧版待处理请求。', 1000, null, null, null, null, 'delivery-pending', null)
    insert.run('ready', 'session-legacy', '旧版已处理请求。', 1100, 'legacy-consumer', 5000, '已经保存的回复。', 2000, 'delivery-ready-stable', null)
    insert.run('sent', 'session-legacy', '旧版已回传请求。', 1200, 'legacy-consumer', 5000, '已经送达的回复。', 2100, 'delivery-sent-stable', 2500)
    originalRows = legacy.prepare('SELECT * FROM messages ORDER BY id').all().map(row => ({ ...row }))
    originalReceiver = { ...legacy.prepare('SELECT * FROM receiver').get() }
  } finally { legacy.close() }

  box = new CodexMailbox(file)
  assert.equal(box.db.prepare('PRAGMA user_version').get().user_version, 2)
  const migrated = box.db.prepare('SELECT * FROM messages ORDER BY id').all()
  assert.ok(migrated.every(row => row.kind === 'write'), 'Legacy tasks must use the conservative write lane')
  assert.ok(migrated.every(row => row.delivery_attempts === 0
    && row.delivery_last_attempt_at_ms === null && row.delivery_retry_after_ms === 0),
  'Legacy replies must start with empty delivery-attempt metadata')
  assert.deepEqual(migrated.map(({ kind: _kind, delivery_attempts: _attempts,
    delivery_last_attempt_at_ms: _lastAttempt, delivery_retry_after_ms: _retryAfter, ...row }) => row), originalRows)
  assert.deepEqual({ ...box.db.prepare('SELECT * FROM receiver').get() }, originalReceiver)
  assert.equal(box.read('pending', 3000).state, 'pending')
  assert.equal(box.read('ready', 3000).state, 'response-ready')
  assert.equal(box.read('sent', 3000).state, 'response-queued')
  box.enqueue({ id: 'pending', sessionId: 'session-legacy', text: '旧版待处理请求。' }, 3000)
  assert.equal(box.read('pending', 3000).createdAtMs, 1000, 'An exact old request retry must remain deduplicated')

  box.close()
  box = undefined
  box = new CodexMailbox(file)
  const deliveries = []
  await box.deliver({ send: async (...args) => deliveries.push(args) }, { now: () => 4000 })
  assert.equal(deliveries.length, 1, 'Only an unsent saved reply should be delivered after migration')
  assert.equal(deliveries[0][2], 'delivery-ready-stable')
  assert.match(deliveries[0][1], /已经保存的回复/)
  assert.equal(box.read('sent', 4000).deliveredAtMs, 2500)
  assert.deepEqual(await box.deliver({ send: async () => assert.fail('Already delivered replies must not be sent again') }), [])
})

test('claim applies active-message exclusions and kind filtering before its SQL limit', t => {
  const f = fixture(t)
  f.enqueue('old-write', 'write')
  f.enqueue('next-review', 'review')
  f.enqueue('later-chat', 'chat')
  assert.deepEqual(f.box.claim('scheduler', { nowMs: 2000, limit: 1 }).map(message => message.id), ['old-write'])
  assert.deepEqual(f.box.claim('scheduler', { nowMs: 2100, limit: 1, excludeIds: ['old-write'] }).map(message => message.id), ['next-review'])
  assert.deepEqual(f.box.claim('scheduler', {
    nowMs: 2200, limit: 1, excludeIds: ['old-write', 'next-review'], kinds: ['chat'],
  }).map(message => message.id), ['later-chat'])
  assert.deepEqual(f.box.claim('scheduler', {
    nowMs: 2300, limit: 1, excludeIds: ['old-write', 'next-review', 'later-chat'],
  }), [])
  assert.equal(f.box.status(2300).pending, 3, 'Claiming does not complete or remove any active request')
})

test('delivery can bypass a failed DSH destination and retry its saved reply with the same request identity', async t => {
  const f = fixture(t)
  f.box.enqueue({ id: 'offline', sessionId: 'session-offline', text: 'first destination', kind: 'review' }, 1000)
  f.box.enqueue({ id: 'online', sessionId: 'session-online', text: 'second destination', kind: 'chat' }, 1001)
  f.box.claim('scheduler', { nowMs: 2000 })
  f.box.respond('offline', 'scheduler', '离线会话的保存回复。', 3000)
  f.box.respond('online', 'scheduler', '在线会话的保存回复。', 3001)
  const attempts = []
  const delivered = await f.box.deliver({ send: async (...args) => {
    attempts.push(args)
    if (args[0] === 'session-offline') throw Error('destination unavailable after possible admission')
  } }, { now: () => 4000, continueOnError: true })
  assert.deepEqual(attempts.map(args => args[0]), ['session-offline', 'session-online'])
  assert.deepEqual(delivered, [{ id: 'online', state: 'response-queued' }])
  assert.equal(f.box.read('offline', 4000).state, 'response-ready')
  assert.equal(f.box.read('online', 4000).state, 'response-queued')
  const retried = []
  const retryClient = { send: async (...args) => retried.push(args) }
  assert.deepEqual(await f.box.deliver(retryClient, { now: () => 33999, continueOnError: true }), [])
  assert.deepEqual(retried, [], 'Automatic retries must respect the full thirty-second backoff')
  assert.equal(f.box.read('offline', 33999).state, 'response-ready')
  await f.box.deliver(retryClient, { now: () => 34000, continueOnError: true })
  assert.deepEqual(retried, [attempts[0]], 'Ambiguous delivery must reuse the complete original DSH request')
  assert.equal(f.box.read('offline', 34000).state, 'response-queued')
  assert.equal(f.box.read('online', 34000).deliveredAtMs, 4000)
})

test('a long repository write does not block the reserved read-only chat lane', async t => {
  const f = fixture(t), releaseWrite = f.gate()
  f.enqueue('long-write', 'write')
  let writing = false
  const job = f.run({ maxTasks: 2, clientFactory: f.factory(async (message, opts, call) => {
    if (message.kind === 'write') {
      writing = true
      await hold(releaseWrite, opts.signal)
      writing = false
      return { text: '写入任务完成。' }
    }
    assert.equal(writing, true, 'Chat must run before the long write finishes')
    assert.equal(call.settings?.readOnly, true)
    return { text: '聊天快速回复。' }
  }) })
  await waitUntil(() => writing, 'long write to enter its blocked turn')
  f.enqueue('quick-chat', 'chat')
  await waitUntil(() => f.box.read('quick-chat').response !== null, 'chat response while write remains blocked')
  assert.equal(f.box.read('long-write').response, null)
  releaseWrite.resolve()
  const state = await job
  assert.equal(state.processed, 2)
  assert.equal(f.calls.length, 2)
  assert.equal(f.box.receiver().state, 'offline')
})

test('two reviews execute together with writes confined to their distinct snapshots', async t => {
  const f = fixture(t), bothStarted = f.gate()
  f.enqueue('review-one', 'review')
  f.enqueue('review-two', 'review')
  const started = new Set()
  const state = await f.run({ maxTasks: 2, clientFactory: f.factory(async (message, opts, call) => {
    started.add(message.id)
    if (started.size === 2) bothStarted.resolve()
    await hold(bothStarted, opts.signal)
    assert.equal(call.settings?.readOnly, false, 'Review tools may build and test inside their isolated snapshot')
    return { text: `复核完成 ${message.id}` }
  }) })
  assert.equal(state.processed, 2)
  assert.equal(started.size, 2)
  assert.equal(f.workspaces.length, 2)
  assert.notEqual(f.calls[0].cwd, f.calls[1].cwd)
  assert.ok(f.calls.every(call => call.cwd !== f.cwd))
})

test('a review with an automatically generated UUID uses a real isolated snapshot without exceeding snapshot id limits', async t => {
  const f = fixture(t)
  execFileSync('git', ['init', '--quiet'], { cwd: f.cwd, windowsHide: true, stdio: 'pipe' })
  writeFileSync(join(f.cwd, 'README.md'), 'A temporary review input.\n')
  const message = f.box.enqueue({ sessionId: 'session-allowed', text: '复核临时仓库。', kind: 'review' })
  assert.match(message.id, /^[a-f\d-]{36}$/)
  const state = await f.run({
    reviewWorkspaceFactory: createReviewWorkspace,
    clientFactory: f.factory(async (request, _opts, call) => {
      assert.equal(request.id, message.id)
      assert.notEqual(call.cwd, f.cwd)
      assert.equal(call.settings?.readOnly, false)
      assert.equal(readFileSync(join(call.cwd, 'README.md'), 'utf8'), 'A temporary review input.\n')
      const manifest = JSON.parse(readFileSync(join(call.cwd, '.codex-review-manifest.json'), 'utf8'))
      assert.equal(manifest.sourceRoot, f.cwd)
      assert.ok(manifest.files.some(file => file.path === 'README.md'))
      return { text: '真实临时副本复核通过。' }
    }),
  })
  assert.equal(state.failures, 0)
  assert.equal(state.processed, 1)
  assert.equal(f.calls.length, 1)
  assert.match(f.box.read(message.id).response, /真实临时副本复核通过/)
})

test('general requests cannot consume the slot reserved for a later chat request', async t => {
  const f = fixture(t), releaseReviews = f.gate()
  for (let i = 0; i < 3; i++) f.enqueue(`review-${i}`, 'review')
  let reviewers = 0
  const job = f.run({ maxTasks: 4, clientFactory: f.factory(async (message, opts) => {
    if (message.kind === 'chat') return { text: '保留的聊天通道可用。' }
    reviewers++
    try { await hold(releaseReviews, opts.signal); return { text: '复核完成。' } }
    finally { reviewers-- }
  }) })
  await waitUntil(() => reviewers >= 2, 'both general-purpose slots')
  assert.equal(reviewers, 2)
  f.enqueue('late-chat', 'chat')
  await waitUntil(() => f.box.read('late-chat').response !== null, 'reserved chat slot while both reviews are blocked')
  assert.equal(f.calls.filter(call => call.kind === 'review').length, 2)
  releaseReviews.resolve()
  assert.equal((await job).processed, 4)
})

test('repository writes never overlap and a waiting second write cannot starve an independent review', async t => {
  const f = fixture(t), writeAndReview = f.gate()
  f.enqueue('write-one', 'write')
  f.enqueue('write-two', 'write')
  let writers = 0, maxWriters = 0, reviewStarted = false, overlap = false
  const job = f.run({ maxTasks: 3, clientFactory: f.factory(async (message, opts) => {
    if (message.kind === 'review') {
      reviewStarted = true
      overlap = writers === 1
      writeAndReview.resolve()
      return { text: '并行复核完成。' }
    }
    writers++
    maxWriters = Math.max(maxWriters, writers)
    try {
      if (message.id === 'write-one') {
        await hold(writeAndReview, opts.signal)
        assert.equal(reviewStarted, true)
      }
      return { text: `写入完成 ${message.id}` }
    } finally { writers-- }
  }) })
  await waitUntil(() => writers === 1, 'first write to hold the repository lock')
  f.enqueue('review', 'review')
  const state = await job
  assert.equal(state.processed, 3)
  assert.equal(maxWriters, 1)
  assert.equal(overlap, true)
  assert.deepEqual(f.calls.filter(call => call.kind === 'write').map(call => call.id), ['write-one', 'write-two'])
})

test('parallel admission reserves the total task budget and never reclaims its own active messages', async t => {
  const f = fixture(t), firstPair = f.gate()
  for (let i = 0; i < 6; i++) f.enqueue(`review-${i}`, 'review')
  const invocations = new Map()
  let started = 0
  const state = await f.run({ maxTasks: 3, clientFactory: f.factory(async (message, opts) => {
    invocations.set(message.id, (invocations.get(message.id) ?? 0) + 1)
    started++
    if (started === 2) firstPair.resolve()
    await hold(firstPair, opts.signal)
    return { text: `完成 ${message.id}` }
  }) })
  assert.equal(state.processed, 3)
  assert.equal(f.calls.length, 3)
  assert.equal(invocations.size, 3)
  assert.ok([...invocations.values()].every(count => count === 1))
  assert.equal(f.box.status().pending, 3)
})

test('generation-scoped stop interrupts every active lane and drains clients before releasing the receiver', async t => {
  const f = fixture(t), never = f.gate()
  for (const kind of ['write', 'review', 'chat']) f.enqueue(kind, kind)
  const running = new Set(), interrupted = new Set(), settled = new Set()
  const job = f.run({ maxTasks: 10, clientFactory: f.factory(async (message, opts, call) => {
    running.add(message.id)
    opts.signal.addEventListener('abort', () => interrupted.add(message.id), { once: true })
    try { await hold(never, opts.signal); return { text: 'fixture cleanup only' } }
    finally {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(call.closed, false, 'Client must remain open until its task settles')
      assert.equal(f.box.receiver().state, 'polling', 'Receiver must stay owned while active work drains')
      settled.add(message.id)
    }
  }) })
  await waitUntil(() => running.size === 3, 'all three independent lanes')
  const active = f.readState().activeTasks
  assert.equal(active.length, 3)
  assert.equal(new Set(active.map(item => item.threadId)).size, 3)
  assert.equal(new Set(active.map(item => item.turnId)).size, 3)
  f.stop()
  const state = await job
  assert.equal(state.state, 'stopped')
  assert.deepEqual([...interrupted].sort(), ['chat', 'review', 'write'])
  assert.deepEqual([...settled].sort(), ['chat', 'review', 'write'])
  assert.ok(f.calls.every(call => call.closed))
  assert.deepEqual(state.activeTasks, [])
  assert.equal(state.active, null)
  assert.equal(f.box.receiver().state, 'offline')
})

test('a successful parallel review cannot erase an unconfirmed write failure or admit the next write', async t => {
  const f = fixture(t), reviewStarted = f.gate()
  f.enqueue('uncertain-write', 'write')
  f.enqueue('successful-review', 'review')
  f.enqueue('next-write', 'write')
  const state = await f.run({ maxTasks: 3, clientFactory: f.factory(async (message, opts) => {
    assert.notEqual(message.id, 'next-write', 'An unconfirmed writer must keep later repository writes blocked')
    if (message.id === 'uncertain-write') {
      await hold(reviewStarted, opts.signal)
      throw Error('CODEX_PROCESS_EXITED')
    }
    reviewStarted.resolve()
    await waitUntil(() => f.readState().quarantine?.messageId === 'uncertain-write', 'durable quarantine before parallel success')
    return { text: '独立复核成功。' }
  }) })
  assert.equal(state.quarantine.messageId, 'uncertain-write')
  assert.equal(state.failures, 1)
  assert.equal(f.calls.length, 2)
  assert.match(f.box.read('successful-review').response, /独立复核成功/)
  assert.match(f.box.read('uncertain-write').response, /终止状态尚未确认/)
  assert.equal(f.calls.some(call => call.id === 'next-write'), false)
})

test('every unresolved parallel crash journal entry survives repeated restarts without model replay', async t => {
  const f = fixture(t)
  f.enqueue('one', 'write')
  f.enqueue('two', 'review')
  const activeTasks = [
    { messageId: 'one', kind: 'write', stage: 'running', threadId: 'thread-one', turnId: 'turn-one' },
    { messageId: 'two', kind: 'review', stage: 'starting', threadId: 'thread-two', turnId: null },
  ]
  writeFileSync(f.stateFile, JSON.stringify({ version: 2, active: activeTasks[0], activeTasks }))
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.run({ clientFactory() { assert.fail('Unresolved turns must never be replayed') } }), /PREVIOUS_TURN_NEEDS_RECONCILIATION/)
    assert.deepEqual(f.readState().activeTasks, activeTasks)
    assert.equal(f.readState().active.messageId, 'one')
  }
  assert.equal(f.box.status().pending, 2)
})

test('a legacy single-active crash journal remains protected after the parallel worker upgrade', async t => {
  const f = fixture(t)
  f.enqueue('legacy', 'write')
  const active = { messageId: 'legacy', stage: 'starting', turnId: 'legacy-unknown' }
  writeFileSync(f.stateFile, JSON.stringify({ active, threadId: 'legacy-thread' }))
  await assert.rejects(f.run({ clientFactory() { assert.fail('Legacy turn must be reconciled first') } }), /PREVIOUS_TURN_NEEDS_RECONCILIATION/)
  assert.equal(f.readState().active.messageId, 'legacy')
  assert.equal(f.readState().active.turnId, 'legacy-unknown')
})

test('invalid concurrency never starts a client or claims the receiver', async t => {
  const f = fixture(t)
  for (const concurrency of [0, 5, 1.5, NaN]) {
    await assert.rejects(f.run({ concurrency, clientFactory() { assert.fail('Invalid limits must not start a model') } }))
    assert.equal(f.box.receiver().state, 'offline')
  }
})
