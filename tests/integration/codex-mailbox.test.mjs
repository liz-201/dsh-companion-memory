import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CodexMailbox } from '../../scripts/codex-mailbox-store.mjs'

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mailbox-'))
  const file = join(dir, 'mailbox.sqlite3')
  const box = new CodexMailbox(file)
  t.after(() => { box.close(); rmSync(dir, { recursive: true, force: true }) })
  return { box, file }
}
const request = (id = 'request-one', text = '请核对共享记忆。') => ({ id, sessionId: 'session-dsh-worker', text })

test('offline requests survive reopening and never claim to wake or complete a Codex turn', t => {
  const { box, file } = fixture(t)
  const sent = box.enqueue(request(), 1000)
  assert.equal(sent.state, 'pending')
  assert.deepEqual(sent.receiver, { state: 'offline', lastSeenAtMs: null })
  assert.equal(sent.wakesCodex, false)
  const other = new CodexMailbox(file)
  try { assert.equal(other.read(sent.id, 2000).text, request().text) } finally { other.close() }
})

test('stable message ids deduplicate exact retries and reject conflicting payloads', t => {
  const { box } = fixture(t)
  const a = box.enqueue(request(), 1000)
  const b = box.enqueue(request(), 2000)
  assert.equal(a.createdAtMs, b.createdAtMs)
  assert.equal(box.status(2000).total, 1)
  assert.throws(() => box.enqueue(request('request-one', 'different'), 2000), /different content/)
  assert.throws(() => box.enqueue({ ...request(), sessionId: 'session-somebody-else' }, 2000), /different content/)
})

test('receiver heartbeat expires honestly, limits consumers, and protects live claims', t => {
  const { box, file } = fixture(t)
  box.enqueue(request(), 1000)
  assert.equal(box.claim('codex-a', { nowMs: 2000, leaseMs: 1000 })[0].state, 'claimed')
  const other = new CodexMailbox(file)
  try {
    assert.throws(() => other.claim('codex-b', { nowMs: 2500 }), /Another mailbox consumer/)
    assert.equal(box.receiver(3000).state, 'offline')
    assert.equal(other.claim('codex-b', { nowMs: 3000 })[0].consumer, 'codex-b')
    assert.throws(() => box.respond('request-one', 'codex-a', 'late', 3100), /Claim this message/)
  } finally { other.close() }
})

test('heartbeat renews the current consumer claims while shutdown releases only its own work', t => {
  const { box } = fixture(t)
  box.enqueue(request(), 1000)
  box.claim('codex-a', { nowMs: 2000, leaseMs: 1000 })
  box.heartbeat('codex-a', 2500, 2000)
  assert.equal(box.read('request-one', 3500).leaseUntilMs, 4500)
  box.offline('other')
  assert.equal(box.receiver(3500).state, 'polling')
  box.offline('codex-a')
  assert.equal(box.read('request-one', 3500).state, 'pending')
  assert.equal(box.receiver(3500).state, 'offline')
})

test('responses require a live claim and retries cannot replace an already recorded response', t => {
  const { box } = fixture(t)
  box.enqueue(request(), 1000)
  assert.throws(() => box.respond('request-one', 'codex-a', 'done', 1100), /Claim this message/)
  box.claim('codex-a', { nowMs: 2000 })
  assert.equal(box.respond('request-one', 'codex-a', '已检查，需补回归。', 3000).state, 'response-ready')
  assert.equal(box.respond('request-one', 'codex-a', '已检查，需补回归。', 4000).respondedAtMs, 3000)
  assert.throws(() => box.respond('request-one', 'codex-a', 'changed', 4000), /different reply/)
  assert.throws(() => box.respond('request-one', 'codex-b', '已检查，需补回归。', 4000), /different reply/)
})

test('ambiguous delivery failures retain the response and reuse the exact DSH request id', async t => {
  const { box } = fixture(t)
  box.enqueue(request(), 1000)
  box.claim('codex-a', { nowMs: 2000 })
  box.respond('request-one', 'codex-a', '已收到。', 3000)
  const calls = []
  const client = { async send(...args) { calls.push(args); if (calls.length === 1) throw Error('timeout after possible admission') } }
  await assert.rejects(box.deliver(client), /timeout/)
  assert.equal(box.read('request-one', 4000).state, 'response-ready')
  await box.deliver(client, { now: () => 5000 })
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[1][0], 'session-dsh-worker')
  assert.deepEqual(calls[1][3], { mode: 'steer' })
  assert.match(calls[1][1], /mailbox request-one/)
  assert.equal(box.read('request-one', 6000).state, 'response-queued')
  assert.deepEqual(await box.deliver(client), [])
  assert.equal(box.status(6000).pending, 0)
})

test('delivery filtering keeps another DSH session reply out of the selected request', async t => {
  const { box } = fixture(t)
  box.enqueue(request(), 1000)
  box.enqueue({ ...request('second'), sessionId: 'session-other' }, 1001)
  box.claim('codex-a', { nowMs: 2000 })
  box.respond('request-one', 'codex-a', 'first', 3000)
  box.respond('second', 'codex-a', 'second', 3001)
  const sessions = []
  await box.deliver({ send: async session => sessions.push(session) }, { id: 'second', now: () => 4000 })
  assert.deepEqual(sessions, ['session-other'])
  assert.equal(box.read('request-one', 5000).state, 'response-ready')
})

test('claims are bounded and oldest requests remain first across consumer restarts', t => {
  const { box } = fixture(t)
  box.enqueue(request('b'), 1001)
  box.enqueue(request('a'), 1000)
  assert.deepEqual(box.claim('codex-a', { nowMs: 2000, limit: 1 }).map(x => x.id), ['a'])
  box.offline('codex-a')
  assert.deepEqual(box.claim('codex-b', { nowMs: 3000 }).map(x => x.id), ['a', 'b'])
})

test('malformed input, oversized UTF-8, timestamps, and path-shaped ids are rejected', t => {
  const { box } = fixture(t)
  for (const r of [request('../escape'), request('x', ''), request('x', '鲸'.repeat(23000)), { ...request(), sessionId: 'wrong' }]) {
    assert.throws(() => box.enqueue(r, 1000))
  }
  assert.throws(() => box.enqueue(request(), NaN), /clock/)
  assert.throws(() => box.claim('codex-a', { leaseMs: 0 }), /Lease/)
  assert.throws(() => box.claim('codex-a', { limit: 21 }), /Limit/)
  assert.equal(box.status(2000).total, 0)
})

test('CLI sends Unicode from stdin, reports offline, and reads the persisted receipt in another process', t => {
  const { file } = fixture(t)
  const script = resolve('scripts/codex-mailbox.mjs')
  const sent = spawnSync(process.execPath, [script, 'send', '--mailbox', file, '--session', 'session-dsh-worker', '--file', '-', '--id', 'cli-test'],
    { input: '鲸鱼娘：请检查双向桥接。', encoding: 'utf8', timeout: 15000 })
  assert.equal(sent.status, 0, sent.stderr)
  const receipt = JSON.parse(sent.stdout)
  assert.equal(receipt.receiver.state, 'offline')
  assert.equal(receipt.text, '鲸鱼娘：请检查双向桥接。')
  const read = spawnSync(process.execPath, [script, 'read', '--mailbox', file, '--id', 'cli-test'], { encoding: 'utf8', timeout: 15000 })
  assert.equal(read.status, 0, read.stderr)
  assert.equal(JSON.parse(read.stdout).id, 'cli-test')
})

test('CLI rejects an unbounded wait and retains replies when DSH is disconnected', t => {
  const { box, file } = fixture(t)
  const script = resolve('scripts/codex-mailbox.mjs')
  const bad = spawnSync(process.execPath, [script, 'receive', '--mailbox', file, '--consumer', 'codex-a', '--wait-ms', '45001'], { encoding: 'utf8', timeout: 15000 })
  assert.equal(bad.status, 1)
  box.enqueue(request())
  box.claim('codex-a')
  const reply = spawnSync(process.execPath, [script, 'reply', '--mailbox', file, '--connection', join(tmpdir(), 'nonexistent-connection-fixture.json'),
    '--id', 'request-one', '--consumer', 'codex-a', '--file', '-'], { input: 'reply retained', encoding: 'utf8', timeout: 15000 })
  assert.equal(reply.status, 2, reply.stderr)
  assert.equal(JSON.parse(reply.stdout).delivery, 'pending-retry')
  assert.equal(box.read('request-one').state, 'response-ready')
})
