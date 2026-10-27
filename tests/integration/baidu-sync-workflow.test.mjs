import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { createTransferHandler } from '../../lib/cloud/transfer-ui.js'
import { apply } from '../../lib/index.js'
import { join } from 'node:path'

const md5 = bytes => createHash('md5').update(bytes).digest('hex')

/** An independent protocol emulator: numeric missing-block indices and the
 * multimedia endpoint are mandatory, regardless of the implementation. */
function baiduApi() {
  const files = new Map(), uploads = new Map(), requests = [], directories = new Set(['/apps'])
  let nextId = 1, nextUpload = 1
  const json = value => Response.json({ errno: 0, ...value })
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw)
    requests.push({ host: url.hostname, path: url.pathname, method: url.searchParams.get('method') })
    if (url.hostname === 'openapi.baidu.com') {
      const form = new URLSearchParams(options.body)
      if (url.pathname.endsWith('/device/code')) {
        assert.equal(form.get('response_type'), 'device_code')
        return Response.json({ device_code: 'DEVICE', user_code: 'TEST-CODE', verification_url: 'https://openapi.baidu.com/device', expires_in: 300, interval: 5 })
      }
      assert.equal(form.get('grant_type'), 'device_token')
      assert.equal(form.get('code'), 'DEVICE')
      return Response.json({ access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600 })
    }
    if (url.hostname === 'd.pcs.baidu.com' && url.pathname.startsWith('/file/')) {
      const file = [...files.values()].find(file => file.id === Number(url.pathname.split('/').at(-1)))
      assert.ok(file)
      return new Response(file.bytes, { headers: { 'content-length': String(file.bytes.length) } })
    }
    const method = url.searchParams.get('method')
    if (method === 'upload') {
      assert.equal(url.hostname, 'd.pcs.baidu.com')
      const boundary = /boundary=([^;]+)/.exec(options.headers['content-type'])[1]
      const bytes = Buffer.from(options.body), headEnd = bytes.indexOf('\r\n\r\n') + 4
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
      assert.deepEqual(bytes.subarray(-tail.length), tail)
      const part = bytes.subarray(headEnd, -tail.length)
      const upload = uploads.get(url.searchParams.get('uploadid'))
      const index = Number(url.searchParams.get('partseq'))
      assert.equal(md5(part), upload.blocks[index])
      upload.parts.set(index, part)
      return json({ md5: md5(part) })
    }
    if (method === 'filemetas') {
      assert.equal(url.pathname, '/rest/2.0/xpan/multimedia')
      const ids = JSON.parse(url.searchParams.get('fsids'))
      return json({ list: ids.map(id => ({ fs_id: id, dlink: `https://d.pcs.baidu.com/file/${id}` })) })
    }
    assert.equal(url.pathname, '/rest/2.0/xpan/file')
    if (method === 'list') {
      const directory = url.searchParams.get('dir')
      return json({ list: [...files.values()].filter(file => file.path.startsWith(directory + '/')).map(file => ({ fs_id: file.id, path: file.path,
        server_filename: file.path.split('/').at(-1), size: file.bytes.length, server_mtime: 1, isdir: 0 })) })
    }
    const form = new URLSearchParams(options.body)
    assert.ok(form.get('path').startsWith('/apps/test-app'))
    if (method === 'precreate') {
      assert.equal(form.get('rtype'), '3', 'file upload must request overwrite instead of conditional rename')
      assert.ok(directories.has(form.get('path').slice(0, form.get('path').lastIndexOf('/'))), 'upload parent must already exist')
      const blocks = JSON.parse(form.get('block_list')), id = String(nextUpload++)
      uploads.set(id, { path: form.get('path'), blocks, parts: new Map() })
      return json({ uploadid: id, return_type: 1, block_list: blocks.map((_, index) => index) })
    }
    if (method === 'create' && form.get('isdir') === '1') {
      const path = form.get('path')
      if (!directories.has(path.slice(0, path.lastIndexOf('/')))) return json({ errno: -9 })
      if (directories.has(path)) return json({ errno: -8 })
      directories.add(path)
      return json({ fs_id: 999, path })
    }
    if (method === 'create') {
      assert.equal(form.get('rtype'), '3')
      const upload = uploads.get(form.get('uploadid'))
      assert.equal(upload.parts.size, upload.blocks.length, 'all numeric-indexed blocks must actually be uploaded')
      const bytes = Buffer.concat(upload.blocks.map((_, index) => upload.parts.get(index)))
      assert.equal(bytes.length, Number(form.get('size')))
      const prior = files.get(upload.path), file = { id: prior?.id ?? nextId++, path: upload.path, bytes }
      files.set(file.path, file)
      return json({ fs_id: file.id, path: file.path, size: bytes.length, mtime: 1, md5: md5(bytes) })
    }
    throw Error(`unexpected protocol method ${method}`)
  }
  return { fetchImpl, requests, files }
}

test('authorization through the UI, export upload/readback, and second-device startup work through the actual Baidu client', async t => {
  const api = baiduApi(), a = fixture(), b = fixture()
  new OwnerIdentity(a.repos, a.config); const ownerB = new OwnerIdentity(b.repos, b.config)
  const configA = { ...a.config, storage: { ...a.config.storage, directory: a.directory } }
  const configB = { ...b.config, storage: { ...b.config.storage, directory: b.directory }, cloud: { ...b.config.cloud, enabled: true } }
  const first = new MemoryTransfer(a.db, configA, 'first-device', { fetchImpl: api.fetchImpl })
  const second = new MemoryTransfer(b.db, configB, 'second-device', { fetchImpl: api.fetchImpl })
  const handler = createTransferHandler(first)
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await first.stop(); await second.stop(); a.close(); b.close() })
  first.start()
  a.repos.insertRawMessage({ id: 'workflow', conversationId: 'c', platformMessageKey: 'workflow', role: 'user', sourceKind: 'dsh', content: '完整链路的记忆', occurredAtMs: a.now(), observedAtMs: a.now(), deliveryStatus: null, deletedAtMs: null })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin + '/companion-memory/manage')).text()
  const token = JSON.parse(/const token=("[^"\n]+")/.exec(page)[1])
  const post = async (action, value = {}) => {
    const response = await fetch(`${origin}/companion-memory/api/${action}`, { method: 'POST', headers: { origin, 'x-companion-token': token, 'content-type': 'application/json' }, body: JSON.stringify(value) })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  const auth = await post('connect', { appKey: 'APP', secretKey: 'SECRET', appFolder: 'test-app' })
  assert.equal(auth.userCode, 'TEST-CODE')
  assert.ok(!JSON.stringify(auth).includes('SECRET'))
  const synced = await post('authorize')
  assert.equal(synced.error, null)
  assert.equal(first.status().connected, true)
  assert.ok(api.files.size > 0)
  const exported = await post('export')
  assert.equal(exported.upload, 'queued')
  await first.sync()
  second.credentials.write(first.credentials.read())
  second.start(); await second.ready
  assert.equal(second.status().error, null)
  assert.equal(b.repos.getRawMessage('workflow').content, '完整链路的记忆')
  assert.equal(ownerB.ownerId, a.repos.getSetting('owner.id'))
  // 两台设备各一份快照，外加目录里一份库清单对象（清单供同一 appFolder 下的其它库识别归属）。
  assert.equal(api.files.size, 3)
  assert.ok(api.requests.some(request => request.path === '/rest/2.0/xpan/multimedia'))
  assert.ok(api.requests.some(request => request.method === 'upload'))
})

test('mounted DSH waits for cloud startup before observing new messages and uses the imported owner identity', async t => {
  const api = baiduApi(), a = fixture(), b = fixture()
  const firstOwner = new OwnerIdentity(a.repos, a.config)
  const source = new MemoryTransfer(a.db, { ...a.config, storage: { ...a.config.storage, directory: a.directory }, cloud: { ...a.config.cloud, enabled: true } }, 'source-device', { fetchImpl: api.fetchImpl })
  a.db.run('INSERT INTO proactive_ownership VALUES (?, ?, ?, ?, NULL)', a.config.companion.id, 'source-device', 'source-ownership', '[]')
  source.credentials.write({ appKey: 'APP', secretKey: 'SECRET', appFolder: 'test-app', tokens: { accessToken: 'ACCESS' } })
  a.repos.insertRawMessage({ id: 'before-startup', conversationId: 'c', platformMessageKey: 'before-startup', role: 'user', sourceKind: 'dsh', content: '云端已有的记忆', occurredAtMs: a.now(), observedAtMs: a.now(), deliveryStatus: null, deletedAtMs: null })
  await source.sync()
  const listeners = new Map(), provided = new Map()
  const originalFetch = globalThis.fetch
  let release, signal, service
  const gate = new Promise(resolve => { release = resolve }), downloading = new Promise(resolve => { signal = resolve })
  globalThis.fetch = async (raw, options) => {
    if (new URL(raw).pathname.startsWith('/file/')) { signal(); await gate }
    return api.fetchImpl(raw, options)
  }
  t.after(async () => { release(); globalThis.fetch = originalFetch; await service?.shutdown(); await source.stop(); a.close(); b.close() })
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) }, provide(name, value) { provided.set(name, value) }, emit() {}, effect() {} }
  apply(ctx, { storage: { directory: b.directory, backupDaily: false }, proactive: { enabled: false }, cloud: { enabled: true, credentialFile: source.credentials.file }, channel: { chatSessionsFile: join(b.directory, 'absent.json') } })
  service = provided.get('companionMemory')
  await downloading
  assert.equal(service.status().sync.cloud.ready, false)
  const capture = listeners.get('session/event')({ id: 'new-device' }, { type: 'user/message', surfaceOp: 'append', seq: 1, time: Date.now(), data: { id: 'after-startup', source: { kind: 'user' }, content: [{ type: 'text', text: '启动同步期间到来的新消息' }] } })
  assert.equal(service.status().counts.raw_messages, 0, 'new messages must wait instead of creating a different owner before restore')
  release(); await capture
  assert.equal(service.status().sync.cloud.error, null)
  assert.equal(service.status().integration.ownerId, firstOwner.ownerId)
  assert.equal(service.status().counts.raw_messages, 2)
  assert.equal(service.status().sync.cloud.ready, true)
  const { DatabaseSync } = await import('node:sqlite')
  const reader = new DatabaseSync(service.status().database, { readOnly: true })
  try {
    assert.deepEqual({ ...reader.prepare('SELECT active_device_id, conflict_json FROM proactive_ownership').get() }, { active_device_id: 'source-device', conflict_json: null })
  } finally { reader.close() }
})
