import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { createTransferHandler } from '../../lib/cloud/transfer-ui.js'
import { PluginPanel } from '../../lib/panel/controller.js'
import { readEroticPolicy } from '../../lib/storage/erotic-interest.js'

const allow = { enabled: true, ownerAdultConfirmed: true, characterAdultConfirmed: true }
async function setup(t, options = {}) {
  const f = fixture(options)
  t.mock.method(Date, 'now', f.now)
  const config = structuredClone(f.config)
  config.storage.directory = f.directory
  const owner = new OwnerIdentity(f.repos, config, f.now(), 'intimacy-panel-device')
  const binding = owner.binding('desktop', 'intimacy-panel-session', owner.deviceId, f.now())
  const other = owner.binding('desktop', 'other-character', owner.deviceId, f.now(), { id: 'other-character', preset: 'gentle' })
  const transfer = new MemoryTransfer(f.db, config, owner.deviceId)
  transfer.start()
  const panel = new PluginPanel({ config, db: f.db, repos: f.repos, owner,
    commands: { config, db: f.db, repos: f.repos, updater: f.updater, retriever: f.retriever, metrics: f.metrics,
      scheduler: { status: () => ({}), setEnabled: value => { config.proactive.enabled = value } } },
    computer: { status: () => ({ running: false, sampling: false, supported: true, lastSampleAtMs: null, error: null, snapshot: null }), recent: () => [] },
    activeTargets: () => [binding], status: () => ({ counts: f.repos.counts() }), settingsChanged: () => {},
    scan: async () => ({}), preview: async () => ({ text: '预览', previewOnly: true }),
    background: { start: () => {}, stop: () => {}, stats: () => ({}) }, review: { begin: () => '', end: () => '' },
  })
  const handler = createTransferHandler(transfer, panel)
  const server = createServer((request, response) => { void handler(request, response) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await transfer.stop(); f.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin + '/companion-memory/manage')).text()
  const token = JSON.parse(/const token=("[^"\n]+")/.exec(page)[1])
  const call = (route, body, headers = {}) => fetch(origin + '/companion-memory/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'x-companion-token': token, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const action = (action, data = {}) => call('panel-action', { action, conversationId: binding.conversationId, ...data })
  const snapshot = async (conversationId = binding.conversationId) => {
    const response = await call(`panel?conversationId=${encodeURIComponent(conversationId)}`)
    assert.equal(response.status, 200)
    return response.json()
  }
  return { ...f, config, owner, binding, other, page, call, action, snapshot }
}

test('HTTP panel defaults off, never fills adult declarations and requires explicit complete confirmation', async t => {
  const f = await setup(t)
  const before = f.db.get('SELECT total_changes() n').n
  const current = await f.snapshot()
  assert.equal(current.eroticPolicy.enabled, false)
  assert.equal(current.eroticPolicy.ownerAdultConfirmed, false)
  assert.equal(current.eroticPolicy.characterAdultConfirmed, false)
  assert.equal(current.eroticState.value, null)
  assert.equal(f.db.get('SELECT total_changes() n').n, before, 'reading controls never changes policy or memory')
  for (const body of [
    { policy: allow },
    { confirmed: true, policy: { enabled: true } },
    { confirmed: true, policy: { ...allow, ownerAdultConfirmed: false } },
    { confirmed: true, policy: { ...allow, characterAdultConfirmed: 'true' } },
    { confirmed: true, policy: { ...allow, characterContextId: 'forged-character' } },
  ]) {
    const response = await f.action('intimacy-settings', body)
    assert.equal(response.status, 400)
    assert.equal(readEroticPolicy(f.repos, f.binding.principalId).enabled, false)
    assert.equal(readEroticPolicy(f.repos, f.binding.principalId).ownerAdultConfirmed, false)
  }
  assert.equal((await f.call('panel', undefined, { 'x-companion-token': 'invalid' })).status, 403)
  assert.equal((await f.call('panel-action', { action: 'intimacy-settings', confirmed: true, policy: allow }, { origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await f.action('intimacy-settings', { conversationId: 'c', confirmed: true, policy: allow })).status, 400)
})

test('HTTP adult confirmation binds to the selected host character rather than all owner conversations', async t => {
  const f = await setup(t)
  const response = await f.action('intimacy-settings', { confirmed: true, policy: allow })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.eroticPolicy.enabled, true)
  assert.equal(result.eroticPolicy.adultsConfirmed, true)
  const own = await f.snapshot()
  assert.equal(own.eroticPolicy.adultsConfirmed, true)
  const other = await f.snapshot(f.other.conversationId)
  assert.equal(other.eroticPolicy.enabled, true, 'the switch belongs to one shared owner')
  assert.equal(other.eroticPolicy.characterAdultConfirmed, false, 'a new host character needs its own assertion')
  assert.equal(other.eroticPolicy.adultsConfirmed, false)
  assert.equal(other.eroticState.value, null)
  assert.equal(other.eroticState.blockReason, 'adult-context-unknown')
  assert.equal(readEroticPolicy(f.repos, f.binding.principalId).characterContextId,
    f.repos.getSetting(`local.session-persona:${f.binding.conversationId}`) ?? 'builtin')
})

test('HTTP stop is immediate across owner windows and only an explicit current acknowledgement can resume', async t => {
  const f = await setup(t)
  assert.equal((await f.action('intimacy-settings', { confirmed: true, policy: allow })).status, 200)
  f.advance(1000)
  const stop = await f.action('intimacy-stop')
  assert.equal(stop.status, 200, 'the stop button needs no extra confirmation')
  const stopped = (await stop.json()).eroticPolicy
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.enabled, false)
  assert.equal(stopped.stopIds.length, 1)
  assert.equal((await f.snapshot(f.other.conversationId)).eroticState.blockReason, 'owner-stop')
  for (const extra of [{}, { confirmedResume: true, knownStopIds: [] }, { confirmedResume: true, knownStopIds: ['stale-stop'] }]) {
    assert.equal((await f.action('intimacy-settings', { confirmed: true, policy: allow, ...extra })).status, 400)
    assert.equal(readEroticPolicy(f.repos, f.binding.principalId).stopped, true)
  }
  f.advance(1000)
  const resumed = await f.action('intimacy-settings', { confirmed: true, policy: allow, confirmedResume: true, knownStopIds: stopped.stopIds })
  assert.equal(resumed.status, 200)
  const policy = (await resumed.json()).eroticPolicy
  assert.equal(policy.stopped, false)
  assert.equal(policy.enabled, true)
  assert.equal(policy.resumeEpochMs, f.now())
  assert.equal((await f.snapshot()).eroticState.value, null, 'resuming creates a fresh evidence epoch')
  assert.equal(f.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n, 1, 'acknowledgement retains the monotonic stop record')
})

test('HTTP panel refuses enabling without continuous emotion or an enforcing expression guard', async t => {
  const f = await setup(t)
  for (const mode of ['emotion-off', 'diagnostic']) {
    f.config.emotion.enabled = mode !== 'emotion-off'
    f.config.expression.mode = mode === 'diagnostic' ? 'diagnostic' : 'enforce'
    assert.equal((await f.action('intimacy-settings', { confirmed: true, policy: allow })).status, 400)
    const policy = readEroticPolicy(f.repos, f.binding.principalId)
    assert.equal(policy.enabled, false)
    assert.equal(policy.adultsConfirmed, false)
  }
  assert.equal((await f.action('intimacy-settings', { confirmed: true,
    policy: { enabled: false, ownerAdultConfirmed: false, characterAdultConfirmed: false } })).status, 200)
})
