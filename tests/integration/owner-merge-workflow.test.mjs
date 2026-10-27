import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, appreciation, insult } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { createTransferHandler } from '../../lib/cloud/transfer-ui.js'
import { exportPortable, stableJson } from '../../lib/storage/portable.js'

class FakeCloud {
  files = new Map()
  uploads = 0
  downloads = 0
  lists = 0
  clock = 1000
  async list(directory) {
    this.lists++
    return [...this.files.values()].filter(file => file.path.startsWith(directory + '/')).map(({ bytes: _bytes, ...file }) => file)
  }
  async upload(path, bytes) {
    this.uploads++
    const file = { id: this.files.get(path)?.id ?? this.files.size + 1, path, name: path.split('/').at(-1),
      size: bytes.length, modifiedAtMs: ++this.clock, bytes: Uint8Array.from(bytes) }
    this.files.set(path, file)
    return file
  }
  async download(file) {
    this.downloads++
    const stored = this.files.get(file.path)
    assert.ok(stored, `Fake cloud file must exist: ${file.path}`)
    return Uint8Array.from(stored.bytes)
  }
}

function setup(t, label, cloud = new FakeCloud(), options = {}) {
  const f = fixture()
  f.db.run('DELETE FROM conversations WHERE id = ?', f.binding.conversationId)
  f.db.run('DELETE FROM principals WHERE id = ?', f.binding.principalId)
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), label)
  const binding = () => owner.binding('dsh', `workflow-${label}`, label, f.now())
  binding()
  const config = { ...f.config, storage: { ...f.config.storage, directory: f.directory },
    cloud: { ...f.config.cloud, enabled: options.enabled ?? true, syncOnStartup: options.syncOnStartup ?? false, autoUpload: true } }
  const transfer = new MemoryTransfer(f.db, config, label, { clientFactory: options.clientFactory ?? (() => cloud), assertMergeIdle: options.assertMergeIdle })
  transfer.credentials.write({ appKey: 'workflow-fake-key', secretKey: 'workflow-fake-secret', appFolder: 'workflow-fake-app',
    tokens: { accessToken: 'workflow-fake-access', refreshToken: 'workflow-fake-refresh' } })
  transfer.start()
  const cleanups = []
  t.after(async () => {
    for (const close of cleanups.reverse()) await close()
    await transfer.stop()
    f.close()
  })
  return { ...f, config, owner, binding, transfer, cloud, cleanups, label }
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('The operation waited for unresolved cloud startup')), 2000)
    })])
  } finally { clearTimeout(timer) }
}

function blockedTransport() {
  let rejectList, entered
  const listEntered = new Promise(resolve => { entered = resolve })
  const transport = {
    cancelled: 0,
    list() { entered(); return new Promise((_, reject) => { rejectList = reject }) },
    cancel() { transport.cancelled++; rejectList?.(Error('fake-original-transport-cancelled')) },
    async upload() { assert.fail('A blocked startup transport must not upload') },
    async download() { assert.fail('A blocked startup transport must not download') },
  }
  return { transport, listEntered }
}

async function seed(f, id, event = appreciation) {
  const binding = f.binding()
  const { row } = f.repos.insertRawMessage({ id, conversationId: binding.conversationId, platformMessageKey: id,
    role: 'user', sourceKind: 'dsh', content: `重要原话 ${id}`, occurredAtMs: f.now(), observedAtMs: f.now(),
    deliveryStatus: null, deletedAtMs: null })
  await f.coordinator.observe(binding, row, { v: 1, e: [event] })
  const previous = new Set(f.db.all('SELECT id FROM memories').map(item => item.id))
  const command = handleFishCommand({ binding, raw: `remember 独立记忆 ${id}`, isOwner: true, nowMs: f.now() }, {
    config: f.config, db: f.db, repos: f.repos, updater: f.updater, retriever: f.retriever, metrics: f.metrics,
  })
  assert.equal(command.kind, 'success')
  const memory = f.db.all('SELECT id FROM memories').find(item => !previous.has(item.id))
  assert.ok(memory)
  return { messageId: id, memoryId: memory.id }
}

function databaseState(db) {
  return Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(({ name }) => [name,
    db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`).map(row => stableJson(row)).sort(),
  ]))
}

function transferBytes(f, filename = 'file-source.companion.json') {
  const file = join(f.directory, filename)
  exportPortable(f.db, f.config, file, { includePlugin: false, nowMs: f.now() })
  return readFileSync(file)
}

async function httpApi(f) {
  const handler = createTransferHandler(f.transfer)
  const server = createServer((request, response) => { void handler(request, response) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  f.cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin + '/companion-memory/manage')).text()
  const tokenMatch = /const token=("[^"\n]+")/.exec(page)
  assert.ok(tokenMatch, 'The real management page must supply its same-origin action token')
  const token = JSON.parse(tokenMatch[1])
  const request = async (action, value = {}) => {
    const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    const response = await fetch(`${origin}/companion-memory/api/${action}`, { method: 'POST',
      headers: { origin, 'x-companion-token': token, 'content-type': bytes ? 'application/octet-stream' : 'application/json' },
      body: bytes ? value : JSON.stringify(value) })
    return { status: response.status, body: await response.json() }
  }
  return { request, page }
}

async function sync(f) {
  await f.transfer.sync()
  assert.equal(f.transfer.status().error, null, f.transfer.status().error ?? undefined)
}

function assertSources(f, sources, activeEvents) {
  for (const source of sources) {
    assert.equal(f.repos.getRawMessage(source.messageId).content, `重要原话 ${source.messageId}`)
    assert.ok(f.repos.getMemory(source.memoryId))
  }
  const events = f.repos.activeAffectEvents(f.owner.principalId)
  assert.equal(events.length, activeEvents)
  assert.equal(new Set(events.map(event => event.id)).size, activeEvents)
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM affect_snapshots').n, 1)
  assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
}

function assertRelationshipConverged(a, b) {
  const left = a.repos.getSnapshot(a.owner.principalId).snapshot.relationship
  const right = b.repos.getSnapshot(b.owner.principalId).snapshot.relationship
  for (const [key, value] of Object.entries(left)) {
    assert.ok(Math.abs(right[key] - value) <= .002, `Both devices must converge on relationship.${key}: ${value} versus ${right[key]}`)
  }
}

test('two already populated cloud devices explicitly pair, converge and preserve subsequent independent events without scoring twice', async t => {
  const cloud = new FakeCloud(), a = setup(t, 'A', cloud), b = setup(t, 'B', cloud)
  const originalA = await seed(a, 'before-pair-A'), originalB = await seed(b, 'before-pair-B', insult)
  const canonical = a.owner.ownerId, previousB = b.owner.ownerId
  assert.notEqual(canonical, previousB)
  await sync(a)
  const beforeFailure = databaseState(b.db), uploads = cloud.uploads
  await b.transfer.sync()
  assert.match(b.transfer.status().error, /不同主人|主人.*不同/)
  assert.equal(cloud.uploads, uploads, 'A failed normal sync must not publish an incompatible second library')
  assert.deepEqual(databaseState(b.db), beforeFailure)
  const beforePreview = databaseState(b.db)
  const preview = await b.transfer.prepareCloudOwnerMerge()
  assert.equal(preview.localOwnerId, previousB)
  assert.equal(preview.remoteOwnerId, canonical)
  assert.deepEqual(preview.blockingConflicts, [])
  assert.deepEqual(databaseState(b.db), beforePreview, 'Cloud preview cannot adopt or import before confirmation')
  assert.equal(cloud.uploads, uploads)
  const confirmed = b.transfer.confirmOwnerMerge(preview.previewToken, 'same-owner-keep-both')
  assert.ok(confirmed.backup && existsSync(confirmed.backup))
  assert.ok(existsSync(confirmed.sourceArchive))
  assert.equal(b.owner.ownerId, canonical)
  assertSources(b, [originalA, originalB], 2)
  await sync(b); await sync(a); await sync(b)
  for (const f of [a, b]) {
    assert.equal(f.owner.ownerId, canonical)
    assertSources(f, [originalA, originalB], 2)
  }
  assertRelationshipConverged(a, b)
  a.advance(1000); b.advance(2000)
  const laterA = await seed(a, 'after-pair-A', appreciation), laterB = await seed(b, 'after-pair-B', insult)
  await sync(a); await sync(b); await sync(a); await sync(b)
  for (const f of [a, b]) assertSources(f, [originalA, originalB, laterA, laterB], 4)
  assertRelationshipConverged(a, b)
  const beforeRepeats = [a, b].map(f => ({
    events: f.db.all('SELECT id, status, payload_json FROM affect_events ORDER BY id'),
    relationship: f.repos.getSnapshot(f.owner.principalId).snapshot.relationship,
  }))
  await sync(a); await sync(b); await sync(a); await sync(b)
  assertRelationshipConverged(a, b)
  for (const [index, f] of [a, b].entries()) {
    assertSources(f, [originalA, originalB, laterA, laterB], 4)
    assert.deepEqual(f.db.all('SELECT id, status, payload_json FROM affect_events ORDER BY id'), beforeRepeats[index].events)
    const relationship = f.repos.getSnapshot(f.owner.principalId).snapshot.relationship
    for (const [key, value] of Object.entries(beforeRepeats[index].relationship)) {
      assert.ok(Math.abs(relationship[key] - value) <= .002, `Repeated sync must not apply ${key} events again`)
    }
  }
})

test('the actual HTTP file flow previews, rejects absent or wrong approval and confirms both histories without relaxing ordinary import', async t => {
  const a = setup(t, 'A', undefined, { enabled: false }), b = setup(t, 'B', undefined, { enabled: false })
  const sourceA = await seed(a, 'http-A'), sourceB = await seed(b, 'http-B', insult)
  const bytes = transferBytes(a), api = await httpApi(b)
  const scripts = [...api.page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length)
  for (const [, script] of scripts) assert.doesNotThrow(() => new Function(script))
  assert.match(api.page, /首次配对/)
  const before = databaseState(b.db)
  const ordinary = await api.request('import', bytes)
  assert.equal(ordinary.status, 409)
  assert.equal(ordinary.body.code, 'owner-mismatch')
  assert.deepEqual(databaseState(b.db), before)
  const response = await api.request('merge-preview', bytes)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const preview = response.body
  assert.ok(preview.previewToken)
  assert.deepEqual(databaseState(b.db), before)
  for (const input of [
    { previewToken: preview.previewToken },
    { previewToken: preview.previewToken, confirmation: 'yes' },
    { previewToken: 'missing-preview', confirmation: 'same-owner-keep-both' },
  ]) {
    assert.equal((await api.request('merge-confirm', input)).status, 400)
    assert.deepEqual(databaseState(b.db), before)
  }
  const result = await api.request('merge-confirm', { previewToken: preview.previewToken, confirmation: 'same-owner-keep-both' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.ok(existsSync(result.body.backup))
  assert.ok(existsSync(result.body.sourceArchive))
  assert.equal(b.owner.ownerId, a.owner.ownerId)
  assertSources(b, [sourceA, sourceB], 2)
  const repeated = await api.request('import', bytes)
  assert.equal(repeated.status, 200)
  assert.equal(repeated.body.alreadyImported, true)
  assertSources(b, [sourceA, sourceB], 2)
})

test('cloud pairing without a discovered candidate reports the prerequisite instead of silently starting a sync', async t => {
  const cloud = new FakeCloud(), f = setup(t, 'alone', cloud)
  await seed(f, 'local-only')
  const before = databaseState(f.db), activity = [cloud.lists, cloud.downloads, cloud.uploads]
  await assert.rejects(f.transfer.prepareCloudOwnerMerge(), /立即同步|先.*同步/)
  assert.deepEqual([cloud.lists, cloud.downloads, cloud.uploads], activity)
  assert.deepEqual(databaseState(f.db), before)
})

test('a new raw message after HTTP preview rejects confirmation with HTTP 400 and requests a fresh preview', async t => {
  const a = setup(t, 'A', undefined, { enabled: false }), b = setup(t, 'B', undefined, { enabled: false })
  await seed(a, 'source-A'); await seed(b, 'source-B')
  const api = await httpApi(b), response = await api.request('merge-preview', transferBytes(a))
  assert.equal(response.status, 200)
  const binding = b.binding()
  b.repos.insertRawMessage({ id: 'arrived-after-preview', conversationId: binding.conversationId, platformMessageKey: 'arrived-after-preview',
    role: 'user', sourceKind: 'dsh', content: '预览后新收到的原话', occurredAtMs: b.now(), observedAtMs: b.now(), deliveryStatus: null, deletedAtMs: null })
  const before = databaseState(b.db)
  const result = await api.request('merge-confirm', { previewToken: response.body.previewToken, confirmation: 'same-owner-keep-both' })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /重新预览|再.*预览/)
  assert.deepEqual(databaseState(b.db), before)
  assert.equal(b.repos.getRawMessage('arrived-after-preview').content, '预览后新收到的原话')
})

test('HTTP local-file preview returns while startup cloud listing remains unresolved', async t => {
  const a = setup(t, 'A', undefined, { enabled: false })
  const { transport, listEntered } = blockedTransport()
  const b = setup(t, 'B', transport, { syncOnStartup: true })
  b.cleanups.push(() => transport.cancel())
  await listEntered
  await seed(a, 'startup-source-A'); await seed(b, 'startup-local-B')
  assert.equal(b.transfer.isReady, false)
  const api = await httpApi(b), before = databaseState(b.db)
  const response = await bounded(api.request('merge-preview', transferBytes(a)))
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.ok(response.body.previewToken)
  assert.equal(b.transfer.isReady, false, 'A successful local preview must not depend on resolving cloud startup')
  assert.equal(b.transfer.status().busy, true)
  assert.deepEqual(databaseState(b.db), before)
  assert.equal(transport.cancelled, 0)
})

test('cloud preview rejects during pending startup and stop or disconnect still cancels the original transport', async t => {
  for (const action of ['stop', 'disconnect']) {
    const { transport, listEntered } = blockedTransport()
    let factoryCalls = 0, replacementCancelled = 0
    const replacement = { ...transport, cancel() { replacementCancelled++ } }
    const f = setup(t, action, transport, { syncOnStartup: true, clientFactory: () => {
      factoryCalls++
      return factoryCalls === 1 ? transport : replacement
    } })
    f.cleanups.push(() => transport.cancel())
    await listEntered
    const before = databaseState(f.db)
    await assert.rejects(bounded(f.transfer.prepareCloudOwnerMerge()), /正在同步|同步.*结束/)
    assert.equal(factoryCalls, 1, 'A refused cloud preview cannot replace the in-flight transport')
    assert.equal(transport.cancelled, 0)
    assert.equal(replacementCancelled, 0)
    assert.deepEqual(databaseState(f.db), before)
    await bounded(f.transfer[action]())
    await bounded(f.transfer.ready)
    assert.equal(transport.cancelled, 1, `${action} must cancel the original startup request`)
    assert.equal(replacementCancelled, 0)
    assert.equal(f.transfer.status().busy, false)
  }
})

test('the production-facing queue-idle callback prevents confirmed file pairing while the host queue is active', async t => {
  let idle = true, checks = 0
  const a = setup(t, 'A', undefined, { enabled: false })
  const b = setup(t, 'B', undefined, { enabled: false, assertMergeIdle: () => {
    checks++
    if (!idle) throw Error('queue-is-active-for-test')
  } })
  await seed(a, 'source-A'); await seed(b, 'source-B')
  const preview = b.transfer.prepareOwnerMerge(transferBytes(a))
  const before = databaseState(b.db)
  idle = false
  assert.throws(() => b.transfer.confirmOwnerMerge(preview.previewToken, 'same-owner-keep-both'), /queue-is-active-for-test/)
  assert.equal(checks, 1)
  assert.deepEqual(databaseState(b.db), before)
  idle = true
  b.transfer.confirmOwnerMerge(preview.previewToken, 'same-owner-keep-both')
  assert.equal(checks, 2)
  assert.equal(b.owner.ownerId, a.owner.ownerId)
})
