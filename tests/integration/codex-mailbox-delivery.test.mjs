import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { CodexMailbox } from '../../scripts/codex-mailbox-store.mjs'

function fixture(t, { initialize = true } = {}) {
  const temporaryBase = realpathSync(tmpdir())
  const directory = mkdtempSync(join(temporaryBase, 'codex-mailbox-delivery-'))
  const file = join(directory, 'mailbox.sqlite3')
  const boxes = []
  const open = () => { const box = new CodexMailbox(file); boxes.push(box); return box }
  t.after(() => {
    for (const box of boxes) { try { box.close() } catch {} }
    const target = resolve(directory)
    assert.equal(dirname(target), temporaryBase)
    assert.match(basename(target), /^codex-mailbox-delivery-[a-z\d]+$/iu)
    rmSync(target, { recursive: true, force: true })
  })
  return { box: initialize ? open() : null, file, open }
}

function reply(box, id, sessionId, sequence = 0) {
  box.enqueue({ id, sessionId, text: `request ${id}` }, 1000 + sequence)
  box.claim('delivery-test', { nowMs: 2000, limit: 20 })
  box.respond(id, 'delivery-test', `reply ${id}`, 3000 + sequence)
}

test('automatic delivery backs off 21 offline destinations so a later online reply can progress', async t => {
  const { box } = fixture(t)
  for (let index = 0; index < 21; index++) reply(box, `offline-${index}`, `session-offline-${index}`, index)
  reply(box, 'online', 'session-online', 21)
  const calls = [], requestIds = new Map()
  let active = 0, maximum = 0
  const client = { async send(session, text, requestId, options) {
    calls.push(session)
    requestIds.set(session, requestId)
    assert.deepEqual(options, { mode: 'steer' })
    active++; maximum = Math.max(maximum, active)
    try {
      await nextTick()
      if (session !== 'session-online') throw Error('offline sensitive server response')
    } finally { active-- }
  } }
  const now = () => 5000
  assert.deepEqual(await box.deliver(client, { now, continueOnError: true }), [])
  assert.equal(calls.length, 20)
  assert.equal(maximum, 4)
  assert.deepEqual(await box.deliver(client, { now, continueOnError: true }), [{ id: 'online', state: 'response-queued' }])
  assert.equal(calls.length, 22)
  assert.equal(new Set(calls).size, 22)
  assert.equal(new Set(requestIds.values()).size, 22)
  assert.deepEqual(await box.deliver(client, { now, continueOnError: true }), [])
  assert.equal(box.read('online', 5000).state, 'response-queued')
  assert.equal(box.status(5000).repliesAwaitingDelivery, 21)
  assert.ok(!JSON.stringify(box.db.prepare('SELECT * FROM messages').all()).includes('sensitive server response'))
})

test('one offline destination does not serially consume a batch of 20 network timeouts', async t => {
  const { box } = fixture(t)
  for (let index = 0; index < 20; index++) reply(box, `offline-${index}`, 'session-offline', index)
  reply(box, 'online', 'session-online', 20)
  let failures = 0
  const client = { async send(session) {
    await nextTick()
    if (session === 'session-offline') { failures++; throw Error('offline') }
  } }
  await box.deliver(client, { now: () => 5000, continueOnError: true })
  assert.ok(failures >= 1 && failures <= 4)
  assert.equal(box.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE delivery_retry_after_ms=35000').get().count, 20)
  assert.deepEqual(await box.deliver(client, { now: () => 5000, continueOnError: true }), [{ id: 'online', state: 'response-queued' }])
})

test('delivery attempts and a 30-second retry boundary survive reopening with the same request identity', async t => {
  const { box, open } = fixture(t)
  reply(box, 'persisted', 'session-offline')
  let nowMs = 10000
  const calls = []
  await box.deliver({ async send(...args) { calls.push(args); throw Error('ambiguous admission') } }, { now: () => nowMs, continueOnError: true })
  assert.deepEqual({ ...box.db.prepare(`SELECT delivery_attempts,delivery_last_attempt_at_ms,delivery_retry_after_ms
    FROM messages WHERE id='persisted'`).get() }, {
    delivery_attempts: 1, delivery_last_attempt_at_ms: 10000, delivery_retry_after_ms: 40000,
  })
  box.close()
  const reopened = open()
  const client = { async send(...args) { calls.push(args) } }
  nowMs = 39999
  assert.deepEqual(await reopened.deliver(client, { now: () => nowMs, continueOnError: true }), [])
  assert.equal(calls.length, 1)
  nowMs = 40000
  assert.deepEqual(await reopened.deliver(client, { now: () => nowMs, continueOnError: true }), [{ id: 'persisted', state: 'response-queued' }])
  assert.deepEqual(calls[0], calls[1])
  assert.equal(reopened.db.prepare("SELECT delivery_attempts FROM messages WHERE id='persisted'").get().delivery_attempts, 2)
  assert.equal(reopened.db.prepare("SELECT delivery_retry_after_ms FROM messages WHERE id='persisted'").get().delivery_retry_after_ms, 0)
})

test('explicit CLI-style retries ignore backoff and continue to throw the transport error immediately', async t => {
  const { box } = fixture(t)
  reply(box, 'manual', 'session-manual')
  const calls = [], failure = Error('private transport failure')
  const client = { async send(...args) { calls.push(args); if (calls.length < 3) throw failure } }
  await assert.rejects(box.deliver(client, { now: () => 5000 }), error => error === failure)
  await assert.rejects(box.deliver(client, { now: () => 5000 }), error => error === failure)
  assert.deepEqual(await box.deliver(client, { now: () => 5000 }), [{ id: 'manual', state: 'response-queued' }])
  assert.deepEqual(calls[0], calls[1])
  assert.deepEqual(calls[1], calls[2])
  assert.equal(box.db.prepare("SELECT delivery_attempts FROM messages WHERE id='manual'").get().delivery_attempts, 3)
})

test('overlapping calls on one scheduler never send the same message twice and keep concurrency at four', async t => {
  const { box } = fixture(t)
  for (let index = 0; index < 20; index++) reply(box, `reply-${index}`, `session-target-${index}`, index)
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const firstFour = new Promise(resolve => { started = resolve })
  const counts = new Map()
  let active = 0, maximum = 0
  const client = { async send(session, text, requestId) {
    counts.set(requestId, (counts.get(requestId) ?? 0) + 1)
    active++; maximum = Math.max(maximum, active)
    if (active === 4) started()
    try { await gate } finally { active-- }
  } }
  const first = box.deliver(client, { now: () => 5000, continueOnError: true })
  await firstFour
  try { assert.deepEqual(await box.deliver(client, { now: () => 5000, continueOnError: true }), []) }
  finally { release() }
  assert.equal((await first).length, 20)
  assert.equal(maximum, 4)
  assert.equal(counts.size, 20)
  assert.ok([...counts.values()].every(count => count === 1))
})

test('an existing schema-2 mailbox gains retry columns idempotently without losing replies', t => {
  const { file, open } = fixture(t, { initialize: false })
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL, consumer TEXT, lease_until_ms INTEGER,
    response TEXT, responded_at_ms INTEGER, delivery_request_id TEXT NOT NULL UNIQUE,
    delivered_at_ms INTEGER, kind TEXT NOT NULL DEFAULT 'write'
  ); PRAGMA user_version=2;`)
  db.prepare(`INSERT INTO messages(id,session_id,body,created_at_ms,response,responded_at_ms,delivery_request_id)
    VALUES(?,?,?,?,?,?,?)`).run('old', 'session-existing', 'old request', 1000, 'old reply', 3000, 'stable-old-request')
  db.close()
  const box = open()
  assert.equal(box.read('old', 5000).response, 'old reply')
  assert.equal(box.db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(box.db.prepare("SELECT delivery_attempts FROM messages WHERE id='old'").get().delivery_attempts, 0)
  box.close()
  const reopened = open()
  assert.equal(reopened.db.prepare("SELECT delivery_request_id FROM messages WHERE id='old'").get().delivery_request_id, 'stable-old-request')
})
