import test from 'node:test'
import assert from 'node:assert/strict'
import { DshBridgeClient } from '../../scripts/dsh-bridge-client.mjs'

function clientFor(events, { pageSize = 2, onPage, repeat = false } = {}) {
  const reads = []
  let snapshots = 0
  const client = new DshBridgeClient('http://127.0.0.1:12345/?token=test', { fetchImpl: async (_url, options) => {
    const envelope = JSON.parse(options.body), request = envelope.payload.args.request
    let value
    if (envelope.method === 'session/projections') { snapshots++; value = { kind: 'sequenced', asOfSeq: events.at(-1).seq, values: {} } }
    else {
      reads.push(request)
      const eligible = events.filter(event => event.seq <= request.throughSeq && (repeat || request.beforeSeq === undefined || event.seq < request.beforeSeq))
      const selected = eligible.slice(-pageSize)
      value = { records: selected.map(event => ({ type: 'event', event })), hasMore: eligible.length > selected.length }
      onPage?.(reads.length)
    }
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
  } })
  client.cookie = 'operator=test'
  return { client, reads, snapshots: () => snapshots }
}
const event = (seq, type, data) => ({ seq, type, data })
const user = (seq, rpcId) => event(seq, 'user/message', { source: { kind: 'user', rpcId } })
const start = (seq, turn) => event(seq, 'turn/start', { turn })
const end = (seq, turn, kind = 'completed') => event(seq, 'turn/end', { turn, reason: { kind } })

test('wait finds an older exact task across pages while pinning one immutable history cut', async () => {
  const events = [start(0, 1), user(1, 'target'), event(2, 'assistant/message', {}), end(3, 1), start(4, 2), user(5, 'other'), end(6, 2)]
  const f = clientFor(events, { onPage: count => { if (count === 1) events.push(start(7, 3), user(8, 'newer')) } })
  const result = await f.client.wait('worker', 'target', { timeoutMs: 0 })
  assert.equal(result.state, 'completed')
  assert.equal(result.end.data.turn, 1)
  assert.ok(result.pages > 1)
  assert.equal(f.snapshots(), 1)
  assert.ok(f.reads.every(read => read.throughSeq === 6))
})

test('a page starting inside a turn must fetch its missing start before claiming completion', async () => {
  const f = clientFor([start(0, 9), user(1, 'target'), end(2, 9)], { pageSize: 2 })
  const result = await f.client.wait('worker', 'target', { timeoutMs: 0 })
  assert.equal(result.state, 'completed')
  assert.equal(result.pages, 2)
})

test('failure after inbox claim but before user/message is reported as stopped, not pending forever', async () => {
  const message = { id: 'message', source: { rpcId: 'target' } }
  const f = clientFor([
    event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] }),
    start(1, 1), event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }), end(3, 1, 'error')
  ])
  const result = await f.client.wait('worker', 'target', { timeoutMs: 0 })
  assert.equal(result.state, 'stopped')
  assert.equal(result.end.data.reason.kind, 'error')
})

test('cancelled queued input has a durable stopped outcome without any generated turn', async () => {
  const f = clientFor([
    event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source: { rpcId: 'target' } }] }),
    event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  ])
  const result = await f.client.wait('worker', 'target', { timeoutMs: 0 })
  assert.equal(result.state, 'stopped')
  assert.equal(result.reason, 'cancelled-before-run')
})

test('a claimed no-op turn is not task success, while an executed transformed input follows host consumed-work semantics', async () => {
  const events = [
    event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source: { rpcId: 'target' } }] }),
    start(1, 1), event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }), end(3, 1)
  ]
  const noOp = await clientFor(events).client.wait('worker', 'target', { timeoutMs: 0 })
  assert.equal(noOp.state, 'stopped')
  assert.equal(noOp.reason, 'claimed-without-execution')
  events.splice(3, 1, event(3, 'step/start', { turn: 1, step: 1 }), end(4, 1))
  const executed = await clientFor(events).client.wait('worker', 'target', { timeoutMs: 0 })
  assert.equal(executed.state, 'completed')
})

test('a bounded history search reports its limit instead of crediting an unrelated completed turn', async () => {
  const f = clientFor([start(0, 1), user(1, 'target'), end(2, 1), start(3, 2), user(4, 'other'), end(5, 2)])
  const result = await f.client.wait('worker', 'target', { timeoutMs: 0, maxPages: 1 })
  assert.equal(result.state, 'pending')
  assert.equal(result.reason, 'history-window-exhausted')
  await assert.rejects(f.client.wait('worker', 'target', { maxPages: 0 }), /maxPages/)
})

test('repeated or overlapping pages are rejected rather than looping or mixing duplicate evidence', async () => {
  const f = clientFor([start(0, 1), user(1, 'target'), end(2, 1), start(3, 2), user(4, 'other'), end(5, 2)], { repeat: true })
  await assert.rejects(f.client.wait('worker', 'target', { timeoutMs: 0 }), /pagination did not advance/)
})

test('a successful HTTP response with malformed JSON cannot leak its raw body through parse errors', async () => {
  const client = new DshBridgeClient('http://127.0.0.1:12345/?token=private-token', { fetchImpl: async () => new Response('private-token private-cookie not-json', { status: 200 }) })
  client.cookie = 'operator=private-cookie'
  await assert.rejects(client.list(), error => error.message === 'Invalid DSH RPC JSON response' && !error.message.includes('private'))
  client.fetch = async () => Response.json(null)
  await assert.rejects(client.list(), /Invalid or mismatched DSH RPC response/)
})
