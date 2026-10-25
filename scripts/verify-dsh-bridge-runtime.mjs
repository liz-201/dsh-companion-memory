// Local-only acceptance against previously extracted, read-only Desktop code.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '../artifacts/desktop-v03-runtime/node_modules/@deepseek-ai/cordis/lib/index.js'
import { z } from '../artifacts/desktop-v03-runtime/node_modules/zod/index.js'
import { createTypertRemoteInfo } from '../artifacts/desktop-v03-runtime/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.js'
import { inject, mountConnectionDiscovery } from '../integration/codex-bridge/index.mjs'
import { DshBridgeClient } from './dsh-bridge-client.mjs'

const source = readFileSync(new URL('../artifacts/host-api/session-typert.host.js', import.meta.url), 'utf8')
const remote = runInNewContext(source.replace(/^import .*$/gm, '').replace('export const TYPERT', 'const TYPERT') + '\n$remote', { z, createTypertRemoteInfo })
const calls = []
const client = new DshBridgeClient('http://127.0.0.1:12345/?token=local-test', { fetchImpl: async (_url, options) => {
  const envelope = JSON.parse(options.body)
  const method = remote.methods[envelope.method]
  assert.ok(method, envelope.method)
  method.input({ strict: true }).create().parse(envelope.payload.args)
  calls.push(envelope.method)
  const values = {
    'session/list': { items: [] }, 'session/create': { sessionId: 'test-session' },
    'session/prompt': { accepted: true }, 'session/cancel': { accepted: true },
    'session/projections': { kind: 'sequenced', asOfSeq: 0, values: {} },
    'session/page': { records: [], hasMore: false }
  }
  return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: values[envelope.method] } })
} })
client.cookie = 'local-test=operator'
await client.list()
await client.create('D:/project')
await client.send('test-session', 'Review only.', 'request-test')
await client.read('test-session')
await client.cancel('test-session')

const directory = mkdtempSync(join(tmpdir(), 'dsh-bridge-cordis-'))
const ctx = new Context()
let ready
ctx.provide('connection', { authenticatedUrl: base => `${base}/?token=local-test` })
ctx.provide('webServer', { getOrigin: () => 'http://127.0.0.1:12345' })
ctx.provide('appReady', { onReady(callback) { ready = callback; return () => {} } })
try {
  const fork = ctx.plugin({ name: 'codex-bridge-runtime-test', inject, apply: scope => { mountConnectionDiscovery(scope, directory) } })
  await fork
  assert.equal(fork.state, 2, 'Actual Cordis must activate the bridge')
  assert.equal(existsSync(join(directory, 'connection.json')), false)
  ready()
  assert.equal(existsSync(join(directory, 'connection.json')), true)
  await fork.dispose()
  assert.equal(existsSync(join(directory, 'connection.json')), false, 'Actual Cordis disposal removes discovery')
} finally { rmSync(directory, { recursive: true, force: true }) }
const report = { host: 'DSH Desktop 0.2.1-rc.2', strictGeneratedInputSchemas: calls, actualCordisLifecycle: 'passed', liveDeepSeek: 'not tested by this script' }
writeFileSync(new URL('../artifacts/codex-bridge-runtime-report.json', import.meta.url), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
