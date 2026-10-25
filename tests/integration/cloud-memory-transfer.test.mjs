import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { CredentialStore } from '../../lib/cloud/credentials.js'
import { readPortable, exportPortable, importPortable } from '../../lib/storage/portable.js'
import { deleteScope } from '../../lib/storage/deletion.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'

class FakeCloud {
  files = new Map()
  uploads = 0
  downloads = 0
  failUpload = false
  failDownload = false
  async list(directory) { return [...this.files.values()].filter(file => file.path.startsWith(directory + '/')).map(({ bytes, ...row }) => row) }
  async upload(path, bytes) {
    if (this.failUpload) throw Error('https://example.invalid/?access_token=secret-test-token')
    this.uploads++
    const old = this.files.get(path)
    const file = { id: old?.id ?? this.files.size + 1, path, name: path.split('/').at(-1), size: bytes.length, modifiedAtMs: 1000, bytes: Uint8Array.from(bytes) }
    this.files.set(path, file)
    return file
  }
  async download(file) {
    this.downloads++
    if (this.failDownload) throw Error('offline')
    return this.files.get(file.path).bytes
  }
}
function setup(t, cloud, device, enabled = true) {
  const f = fixture()
  const owner = new OwnerIdentity(f.repos, f.config)
  const config = { ...f.config, storage: { ...f.config.storage, directory: f.directory }, cloud: { ...f.config.cloud, enabled } }
  const transfer = new MemoryTransfer(f.db, config, device, { clientFactory: () => cloud })
  transfer.credentials.write({ appKey: 'test-key', secretKey: 'test-secret', appFolder: 'test-app', tokens: { accessToken: 'test-access', refreshToken: 'test-refresh' } })
  t.after(async () => { await transfer.stop(); f.close() })
  return { ...f, owner, transfer, config }
}
function raw(f, id, content = id) {
  f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh', content,
    occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
}

test('one-click export is a complete importable transfer file and never includes local credentials', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a', false), b = setup(t, cloud, 'b', false)
  raw(a, 'source', '要随文件迁移的原文')
  a.repos.setSetting('local.cloud.enabled', '0', a.now())
  const result = a.transfer.exportLocal()
  const parsed = readPortable(result.file)
  assert.equal(parsed.payload.tables.raw_messages[0].content, '要随文件迁移的原文')
  assert.deepEqual(parsed.payload.plugin, {})
  assert.ok(!JSON.stringify(parsed.payload).includes('test-secret'))
  assert.ok(!JSON.stringify(parsed.payload).includes('test-access'))
  assert.ok(!parsed.payload.tables.plugin_settings.some(row => row.key.startsWith('local.cloud.')))
  const report = b.transfer.importBytes(readFileSync(result.file))
  assert.ok(report.inserted > 0)
  assert.equal(b.repos.getRawMessage('source').content, '要随文件迁移的原文')
  assert.equal(b.owner.ownerId, a.owner.ownerId, 'owner created before the import must observe the imported identity')
  const binding = b.owner.binding('dsh', 'new-session')
  assert.equal(binding.principalId, a.owner.principalId)
  assert.equal(b.transfer.importFile(result.file).alreadyImported, true)
})

test('opening a new instance downloads cloud memory before startup readiness and publishes its own merged snapshot', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'from-a')
  await a.transfer.sync()
  b.transfer.start()
  assert.equal(b.transfer.isReady, false)
  await b.transfer.ready
  assert.equal(b.transfer.isReady, true)
  assert.equal(b.repos.getRawMessage('from-a').content, 'from-a')
  assert.equal(cloud.files.size, 2, 'each device owns a separate cloud snapshot')
  assert.equal(b.transfer.status().error, null)
})

test('startup bounds cloud network waiting and continues with local memory before retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a')
  a.config.cloud.startupTimeoutSeconds = 1
  raw(a, 'kept-local')
  const list = cloud.list.bind(cloud)
  let cancel, cancelled = 0
  cloud.list = async () => new Promise((_resolve, reject) => { cancel = reject })
  cloud.cancel = () => { cancelled++; cancel(Error('cancelled')) }
  a.transfer.start()
  assert.equal(a.transfer.isReady, false)
  t.mock.timers.tick(1000)
  await a.transfer.ready
  assert.equal(a.transfer.isReady, true)
  assert.equal(cancelled, 1)
  assert.match(a.transfer.status().error, /启动云端检查超时/)
  assert.ok(a.repos.getRawMessage('kept-local'))
  cloud.list = list
  await a.transfer.sync()
  assert.equal(a.transfer.status().error, null)
  assert.equal(cloud.uploads, 1)
})

test('different populated owners receive an actionable diagnosis without combining or publishing memories', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'source-owner'); await a.transfer.sync()
  raw(b, 'different-owner')
  const uploads = cloud.uploads
  await b.transfer.sync()
  assert.match(b.transfer.status().error, /属于不同主人/)
  assert.notEqual(a.owner.ownerId, b.owner.ownerId)
  assert.ok(b.repos.getRawMessage('different-owner'))
  assert.equal(b.repos.getRawMessage('source-owner'), undefined)
  assert.equal(cloud.uploads, uploads)
})

test('two offline devices preserve both new messages, propagate deletion, and skip unchanged uploads', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'shared')
  await a.transfer.sync(); await b.transfer.sync()
  raw(a, 'offline-a'); raw(b, 'offline-b')
  await a.transfer.sync(); await b.transfer.sync(); await a.transfer.sync()
  for (const f of [a, b]) {
    assert.ok(f.repos.getRawMessage('offline-a'))
    assert.ok(f.repos.getRawMessage('offline-b'))
  }
  deleteScope(a.db, a.repos, 'p', { kind: 'message', messageId: 'shared' }, a.now(), 7, a.config)
  await a.transfer.sync(); await b.transfer.sync(); await a.transfer.sync()
  for (const f of [a, b]) assert.equal(f.repos.getRawMessage('shared').content, '')
  const uploads = cloud.uploads
  await a.transfer.sync(); await a.transfer.sync()
  assert.equal(cloud.uploads, uploads, 'an unchanged snapshot is not uploaded again')
  assert.deepEqual(a.db.all('PRAGMA foreign_key_check'), [])
  assert.deepEqual(b.db.all('PRAGMA foreign_key_check'), [])
})

test('cloud checks current bytes even with identical timestamp and file size', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'old-a'); await a.transfer.sync(); await b.transfer.sync()
  raw(a, 'new-a'); await a.transfer.sync()
  const path = [...cloud.files.keys()][0]
  cloud.files.get(path).size = 1 // metadata is intentionally stale; download content remains authoritative
  const before = cloud.downloads
  await b.transfer.sync()
  assert.ok(cloud.downloads > before)
  assert.ok(b.repos.getRawMessage('new-a'))
})

test('an offline peer can receive updates to existing rows after more exports than the checkpoint window', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'edited', 'old content')
  await a.transfer.sync(); await b.transfer.sync(); await a.transfer.sync()
  for (let i = 0; i < 12; i++) {
    a.db.run('UPDATE raw_messages SET content = ? WHERE id = ?', `updated-${i}`, 'edited')
    await a.transfer.sync()
  }
  assert.ok(a.db.get('SELECT COUNT(*) AS n FROM portable_checkpoints').n <= 8)
  await b.transfer.sync()
  assert.equal(b.repos.getRawMessage('edited').content, 'updated-11')
  assert.equal(b.transfer.status().error, null)
})

test('explicit export automatically uploads after connection; a failed upload preserves local data and retries', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a')
  raw(a, 'local')
  cloud.failUpload = true
  assert.equal(a.transfer.exportLocal().upload, 'queued')
  await a.transfer.sync()
  assert.ok(a.repos.getRawMessage('local'))
  assert.equal(cloud.files.size, 0)
  assert.ok(a.transfer.status().error)
  assert.ok(!JSON.stringify(a.transfer.status()).includes('secret-test-token'))
  cloud.failUpload = false
  await a.transfer.sync()
  assert.equal(cloud.files.size, 1)
  assert.equal(a.transfer.status().error, null)
})

test('a failed cloud download never publishes a falsely up-to-date snapshot', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b')
  raw(a, 'cloud-only'); await a.transfer.sync()
  cloud.failDownload = true
  await b.transfer.sync()
  assert.equal(cloud.files.size, 1)
  assert.ok(b.transfer.status().error)
  assert.equal(b.transfer.status().lastSyncAtMs, null)
  cloud.failDownload = false
  await b.transfer.sync()
  assert.ok(b.repos.getRawMessage('cloud-only'))
  assert.equal(cloud.files.size, 2)
})

test('concurrent sync requests share one operation and disconnect retains local and remote memory', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a')
  raw(a, 'local')
  const first = a.transfer.sync(), second = a.transfer.sync()
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(cloud.uploads, 1)
  await a.transfer.disconnect()
  assert.equal(a.transfer.status().enabled, false)
  assert.equal(a.transfer.status().connected, false)
  assert.ok(a.repos.getRawMessage('local'))
  assert.equal(cloud.files.size, 1)
  await a.transfer.sync()
  assert.equal(cloud.uploads, 1)
})

test('a repeated invalid import reuses its backup until local transferable state changes', t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a', false), b = setup(t, cloud, 'b', false)
  const file = join(a.directory, 'bad.json')
  exportPortable(a.db, a.config, file, { includePlugin: false })
  const { payload, checksum } = readPortable(file)
  payload.tables.memory_evidence.push({ memory_id: 'missing-memory', message_id: 'missing-message', quote: 'broken' })
  const count = () => readdirSync(join(b.directory, 'backups')).filter(name => name.endsWith('.sqlite3')).length
  assert.throws(() => importPortable(b.db, b.config, payload, checksum), /references|FOREIGN KEY/i)
  const initial = count()
  assert.ok(initial > 0)
  assert.throws(() => importPortable(b.db, b.config, payload, checksum), /references|FOREIGN KEY/i)
  assert.equal(count(), initial)
  raw(b, 'changed')
  b.repos.setSetting('owner.id', a.owner.ownerId, b.now())
  assert.throws(() => importPortable(b.db, b.config, payload, checksum), /references|FOREIGN KEY/i)
  assert.equal(count(), initial + 1)
})

test('full file commands require owner access and use the transfer service', t => {
  const a = setup(t, new FakeCloud(), 'a', false)
  a.transfer.start()
  raw(a, 'export-command')
  const deps = { ...a, transfer: a.transfer, manageUrl: () => 'http://127.0.0.1:9000/companion-memory/manage' }
  const command = (raw, isOwner) => handleFishCommand({ raw, isOwner, binding: a.binding, nowMs: a.now() }, deps)
  assert.equal(command('export', false).kind, 'error')
  assert.equal(command('import', false).kind, 'error')
  assert.equal(command('sync', false).kind, 'error')
  const result = command('export', true)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /companion\.json/)
  assert.match(result.text, /完整记忆文件/)
  assert.match(command('files', true).text, /127\.0\.0\.1:9000/)
})

test('a server that acknowledges upload but returns different bytes is never marked successfully synced', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a')
  const download = cloud.download.bind(cloud)
  cloud.download = async file => { const bytes = await download(file); return Uint8Array.from([...bytes, 0]) }
  raw(a, 'kept-local')
  await a.transfer.sync()
  assert.equal(a.transfer.status().lastSyncAtMs, null)
  assert.ok(a.transfer.status().error)
  assert.equal(a.repos.getSetting('local.cloud.upload-fingerprint'), undefined)
  assert.ok(a.repos.getRawMessage('kept-local'))
})

test('memory created during upload triggers an immediate follow-up instead of waiting for the next timer', async t => {
  const cloud = new FakeCloud(), a = setup(t, cloud, 'a'), b = setup(t, cloud, 'b', false)
  let notify, release, hold = true
  const started = new Promise(resolve => { notify = resolve })
  const proceed = new Promise(resolve => { release = resolve })
  const upload = cloud.upload.bind(cloud)
  cloud.upload = async (...args) => { if (hold) { hold = false; notify(); await proceed } return upload(...args) }
  raw(a, 'before-upload')
  const first = a.transfer.sync()
  await started
  raw(a, 'during-upload')
  release(); await first; await a.transfer.sync()
  assert.equal(cloud.uploads, 2)
  const file = [...cloud.files.values()][0]
  b.transfer.importBytes(file.bytes)
  assert.ok(b.repos.getRawMessage('before-upload'))
  assert.ok(b.repos.getRawMessage('during-upload'))
})

test('credential file is separate from export and its status does not reveal secret fields', t => {
  const a = setup(t, new FakeCloud(), 'a', false)
  const store = new CredentialStore(a.transfer.credentials.file)
  assert.equal(store.read().tokens.refreshToken, 'test-refresh')
  assert.ok(!JSON.stringify(a.transfer.status()).includes('test-refresh'))
  store.disconnect()
  assert.equal(store.read(), null)
})

test('disconnect during an authorization poll cannot recreate credentials or re-enable sync', async t => {
  const f = fixture()
  new OwnerIdentity(f.repos, f.config)
  let notify, release
  const started = new Promise(resolve => { notify = resolve }), gate = new Promise(resolve => { release = resolve })
  const transfer = new MemoryTransfer(f.db, { ...f.config, storage: { ...f.config.storage, directory: f.directory } }, 'a', {
    fetchImpl: async raw => {
      if (new URL(raw).pathname.endsWith('/device/code')) return Response.json({ device_code: 'CODE', user_code: 'USER', verification_url: 'https://openapi.baidu.com/device', expires_in: 300 })
      notify(); await gate
      return Response.json({ access_token: 'late-token', refresh_token: 'late-refresh', expires_in: 3600 })
    },
  })
  t.after(async () => { release(); await transfer.stop(); f.close() })
  transfer.start()
  await transfer.beginAuthorization({ appKey: 'key', secretKey: 'secret', appFolder: 'app' })
  const poll = transfer.finishAuthorization()
  await started; await transfer.disconnect(); release()
  await assert.rejects(poll)
  assert.equal(transfer.credentials.read(), null)
  assert.equal(transfer.status().enabled, false)
})
