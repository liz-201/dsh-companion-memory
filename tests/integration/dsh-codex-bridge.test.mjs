import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { publishConnection, mountConnectionDiscovery } from '../../integration/codex-bridge/index.mjs'
import { DshBridgeClient, localConnectionUrl } from '../../scripts/dsh-bridge-client.mjs'

test('desktop publisher keeps credentials outside the repository and old teardown preserves the new generation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const ctx = { connection: { authenticatedUrl: base => `${base}?token=local-test-secret` }, webServer: { getOrigin: () => 'http://127.0.0.1:12345' } }
  const disposeOld = publishConnection(ctx, directory)
  const descriptor = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8'))
  assert.equal(descriptor.version, 1)
  assert.equal(new URL(descriptor.url).searchParams.get('token'), 'local-test-secret')
  const disposeNew = publishConnection(ctx, directory)
  disposeOld()
  assert.ok(existsSync(join(directory, 'connection.json')))
  disposeNew()
  assert.equal(existsSync(join(directory, 'connection.json')), false)
})

test('discovery refuses network endpoints and missing launch credentials', () => {
  for (const url of ['http://example.com:123/?token=x', 'https://127.0.0.1:123/?token=x', 'http://127.0.0.1:123/', 'http://user:password@127.0.0.1:123/?token=x']) {
    assert.throws(() => localConnectionUrl(url))
  }
})

test('publisher waits for Desktop appReady and cancels delayed publication when unloaded', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-ready-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let callback
  let cancelled = false
  let cleanup
  const ctx = {
    get: name => name === 'appReady' ? { onReady(fn) { callback = fn; return () => { cancelled = true } } } : undefined,
    effect(fn) { cleanup = fn(); return cleanup },
    connection: { authenticatedUrl: base => `${base}?token=ready-test` },
    webServer: { getOrigin() { assert.ok(ready); return 'http://127.0.0.1:12345' } }
  }
  let ready = false
  mountConnectionDiscovery(ctx, directory)
  assert.equal(existsSync(join(directory, 'connection.json')), false)
  ready = true
  callback()
  assert.equal(existsSync(join(directory, 'connection.json')), true)
  cleanup()
  assert.equal(cancelled, true)
  assert.equal(existsSync(join(directory, 'connection.json')), false)
  callback()
  assert.equal(existsSync(join(directory, 'connection.json')), false)
})

test('current Desktop getOrigin is authoritative and legacy origin is never read', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-origin-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const ctx = { webServer: { getOrigin() { return 'http://127.0.0.1:12345' }, get origin() { assert.fail('current host has no origin property') } },
    connection: { authenticatedUrl(base) { assert.equal(base, 'http://127.0.0.1:12345/'); return `${base}?token=test` } } }
  const dispose = publishConnection(ctx, directory)
  assert.equal(existsSync(join(directory, 'connection.json')), true)
  dispose()
})

test('missing listener origin is rejected before authentication receives undefined', () => {
  const ctx = { webServer: {}, connection: { authenticatedUrl() { assert.fail('undefined must never reach BrowserAuth') } } }
  assert.throws(() => publishConnection(ctx), /origin is not ready/)
})

test('discovery errors cannot escape the startup readiness callback or expose credentials', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let ready, cleanup
  const warnings = []
  t.mock.method(console, 'warn', text => warnings.push(text))
  const ctx = { get: () => ({ onReady(fn) { ready = fn; return () => {} } }), effect(fn) { cleanup = fn() },
    webServer: { getOrigin() { throw new Error('not listening; secret-token-in-message') } },
    connection: { authenticatedUrl() { assert.fail('not ready') } } }
  mountConnectionDiscovery(ctx, directory)
  assert.doesNotThrow(() => ready())
  assert.equal(existsSync(join(directory, 'connection.json')), false)
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(warnings[0], /secret-token/)
  cleanup()
})

test('publication errors without appReady also leave the host running', t => {
  t.mock.method(console, 'warn', () => {})
  let cleanup
  assert.doesNotThrow(() => mountConnectionDiscovery({ effect(fn) { cleanup = fn() }, webServer: {}, connection: {} }))
  assert.doesNotThrow(() => cleanup())
})

test('authenticated HTTP flow preserves DSH named arguments, task identity, queue delivery, and durable history cut', async t => {
  const prompts = new Map()
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { rpcId: 'old-task' } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ]
  const calls = []
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/connect?')) {
      const url = new URL(req.url, 'http://localhost')
      assert.equal(url.searchParams.get('token'), 'test-launch')
      assert.equal(url.searchParams.get('interactions'), 'none')
      res.writeHead(302, { 'set-cookie': 'dsh_operator=signed; HttpOnly', location: './api/remote.mux' }).end()
      return
    }
    assert.equal(req.headers.cookie, 'dsh_operator=signed')
    assert.equal(req.method, 'POST')
    let body = ''
    for await (const chunk of req) body += chunk
    const envelope = JSON.parse(body)
    assert.equal(req.url, `/api/${envelope.method}`)
    assert.equal(envelope.type, 'client-request')
    const args = envelope.payload.args
    calls.push(envelope.method)
    let value
    switch (envelope.method) {
      case 'session/list':
        assert.deepEqual(args, { _request: {} })
        value = { items: [{ sessionId: 'worker', running: false }] }
        break
      case 'session/create':
        assert.equal(args.request.cwd, 'D:/project')
        value = { sessionId: 'worker' }
        break
      case 'session/prompt': {
        assert.equal(args.request.mode, 'queue')
        assert.equal(args.request.clientTimeZone, 'Asia/Shanghai')
        const { requestId } = args.request
        if (!prompts.has(requestId)) prompts.set(requestId, args.request)
        value = { accepted: true }
        break
      }
      case 'session/projections': value = { kind: 'sequenced', asOfSeq: events.at(-1).seq, values: {} }; break
      case 'session/page':
        assert.equal(args.request.address.sessionId, 'worker')
        assert.equal(args.request.throughSeq, events.at(-1).seq)
        value = { records: events.map(event => ({ type: 'event', event })), hasMore: false }
        break
      case 'session/cancel': value = { accepted: true }; break
      default: assert.fail(envelope.method)
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const client = new DshBridgeClient(`http://127.0.0.1:${server.address().port}/?token=test-launch`)
  assert.equal((await client.list()).items.length, 1)
  assert.equal((await client.create('D:/project')).sessionId, 'worker')
  await client.send('worker', 'Review the plugin; do not edit files.', 'task-2')
  await client.send('worker', 'Review the plugin; do not edit files.', 'task-2')
  assert.equal(prompts.size, 1, 'Retry must keep the original durable request identity')
  assert.equal((await client.wait('worker', 'task-2', { timeoutMs: 0 })).state, 'pending', 'An older idle turn cannot complete the queued task')
  events.push({ seq: 3, type: 'turn/start', data: { turn: 2 } }, { seq: 4, type: 'user/message', data: { source: { rpcId: 'task-2' } } })
  assert.equal((await client.wait('worker', 'task-2', { timeoutMs: 0 })).state, 'pending')
  events.push({ seq: 5, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal((await client.wait('worker', 'task-2', { timeoutMs: 0 })).state, 'completed')
  events[5].data.reason.kind = 'error'
  assert.equal((await client.wait('worker', 'task-2', { timeoutMs: 0 })).state, 'stopped', 'Model errors must not report task success')
  assert.deepEqual(await client.cancel('worker'), { accepted: true })
  assert.ok(calls.includes('session/page'))
})

test('authentication errors and RPC failures never echo secrets or raw server error bodies', async () => {
  const failedAuth = new DshBridgeClient('http://127.0.0.1:1234/?token=secret-value', { fetchImpl: async () => new Response('secret-value', { status: 401 }) })
  await assert.rejects(failedAuth.connect(), error => !error.message.includes('secret-value'))
  const failedRpc = new DshBridgeClient('http://127.0.0.1:1234/?token=secret-value', { fetchImpl: async () => new Response('secret-value', { status: 500 }) })
  failedRpc.cookie = 'operator=private'
  await assert.rejects(failedRpc.list(), error => !error.message.includes('secret-value') && !error.message.includes('private'))
})
