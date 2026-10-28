import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import vm from 'node:vm'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { createTransferHandler } from '../../lib/cloud/transfer-ui.js'

async function setup(t, options = {}, lifecycle, controls) {
  const f = fixture()
  new OwnerIdentity(f.repos, f.config)
  const config = { ...f.config, storage: { ...f.config.storage, directory: f.directory } }
  const transfer = new MemoryTransfer(f.db, config, 'ui-device', options)
  transfer.start()
  const handler = createTransferHandler(transfer, controls, lifecycle)
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await transfer.stop(); f.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const pageResponse = await fetch(origin + '/companion-memory/manage')
  const page = await pageResponse.text()
  const token = JSON.parse(/const token=("[^"\n]+")/.exec(page)[1])
  const call = (action, body, headers = {}) => fetch(`${origin}/companion-memory/api/${action}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-companion-token': token, origin, ...headers }, body,
  })
  return { ...f, transfer, origin, token, page, call, pageResponse }
}

test('management page offers file import/export, official authorization and sync without exposing credentials', async t => {
  const f = await setup(t)
  assert.match(f.page, /导出并下载记忆/)
  assert.match(f.page, /导入所选记忆/)
  assert.match(f.page, /连接百度网盘/)
  assert.match(f.page, /立即同步/)
  assert.equal(f.pageResponse.headers.get('cache-control'), 'no-store')
  assert.match(f.pageResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal((await f.call('status')).status, 200)
  assert.equal((await fetch(f.origin + '/companion-memory/api/status')).status, 403)
  assert.equal((await f.call('export', '{}', { origin: 'https://malicious.invalid' })).status, 403)
  assert.equal((await f.call('export')).status, 405)
})

test('closeout lifecycle routes use the same real HTTP token and origin gate', async t => {
  let paused = false, changes = 0
  const state = () => ({ paused, drained: paused, activeLeases: 0, foreground: 0, pending: 0 })
  const f = await setup(t, {}, {
    pause: async () => { paused = true; changes++; return state() },
    status: state,
    resume: async () => { paused = false; changes++; return state() },
  })
  assert.equal((await fetch(f.origin + '/companion-memory/api/closeout-pause', { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await f.call('closeout-pause', '{}', { origin: 'https://other.invalid' })).status, 403)
  assert.equal(changes, 0)
  assert.equal((await f.call('closeout-status')).status, 200)
  assert.equal((await (await f.call('closeout-pause', '{}')).json()).drained, true)
  assert.equal((await (await f.call('closeout-status')).json()).paused, true)
  for (const action of ['import', 'connect', 'authorize', 'disconnect', 'merge-preview', 'merge-cloud-preview', 'merge-confirm']) {
    const response = await f.call(action, '{}')
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'closeout-paused')
  }
  assert.equal((await f.call('export', '{}')).status, 200)
  assert.equal((await f.call('sync', '{}')).status, 200)
  assert.equal((await f.call('closeout-pause')).status, 405)
  assert.equal((await (await f.call('closeout-resume', '{}')).json()).paused, false)
  assert.equal(changes, 2)
})

test('a pause waits for already-admitted HTTP mutations and rejects later mutations', async t => {
  let paused = false, entered, release
  const running = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const state = () => ({ paused, drained: paused, activeLeases: 0, foreground: 0, pending: 0 })
  const f = await setup(t, {}, { pause: () => { paused = true; return state() }, status: state, resume: () => { paused = false; return state() } },
    { snapshot: () => ({}), action: async () => { entered(); await gate; return { done: true } } })
  t.after(() => release())
  const mutation = f.call('panel-action', '{}')
  await running
  const pause = f.call('closeout-pause', '{}')
  let status
  for (let attempt = 0; attempt < 20; attempt++) {
    status = await (await f.call('closeout-status')).json()
    if (status.paused) break
  }
  assert.equal(status.paused, true)
  assert.equal(status.drained, false)
  assert.equal(status.foreground, 1)
  assert.equal((await f.call('panel-action', '{}')).status, 409)
  release()
  assert.equal((await mutation).status, 200)
  assert.equal((await (await pause).json()).drained, true)
  assert.equal((await (await f.call('closeout-status')).json()).foreground, 0)
})

test('a failed pause retains the admission barrier until an explicit resume', async t => {
  const state = () => ({ paused: false, drained: false, activeLeases: 0, foreground: 0, pending: 0 })
  const f = await setup(t, {}, { pause: () => { throw Error('private runtime details') }, status: state, resume: state })
  const response = await f.call('closeout-pause', '{}')
  assert.equal(response.status, 400)
  assert.ok(!(await response.text()).includes('private runtime details'))
  assert.equal((await (await f.call('closeout-status')).json()).paused, true)
  assert.equal((await f.call('connect', '{}')).status, 409)
  assert.equal((await f.call('closeout-resume', '{}')).status, 200)
  assert.equal((await f.call('connect', '{}')).status, 400)
})

test('a handler without runtime lifecycle support diagnoses old closeout endpoints instead of claiming a pause', async t => {
  const f = await setup(t)
  for (const [name, body] of [['closeout-status', undefined], ['closeout-pause', '{}'], ['closeout-resume', '{}']]) {
    const response = await f.call(name, body)
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, 'closeout-unsupported')
  }
})

test('a real HTTP export downloads a complete file which a second instance imports through its upload endpoint', async t => {
  const a = await setup(t), b = await setup(t)
  a.repos.insertRawMessage({ id: 'ui-message', conversationId: 'c', platformMessageKey: 'ui-message', role: 'user', sourceKind: 'dsh',
    content: '来自界面导出的记忆', occurredAtMs: a.now(), observedAtMs: a.now(), deliveryStatus: null, deletedAtMs: null })
  const exported = await (await a.call('export', '{}')).json()
  assert.match(exported.name, /\.companion\.json$/)
  const response = await fetch(a.origin + exported.download)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition'), /attachment/)
  const bytes = Buffer.from(await response.arrayBuffer())
  const imported = await b.call('import', bytes, { 'content-type': 'application/octet-stream' })
  assert.equal(imported.status, 200)
  assert.ok((await imported.json()).inserted > 0)
  assert.equal(b.repos.getRawMessage('ui-message').content, '来自界面导出的记忆')
  assert.equal((await b.call('import', bytes)).status, 200)
  assert.equal(b.db.get("SELECT COUNT(*) AS n FROM raw_messages WHERE id = 'ui-message'").n, 1)
})

test('corrupt imports and incomplete app settings fail without changing local data or echoing submitted secrets', async t => {
  const f = await setup(t)
  const before = f.repos.counts()
  const imported = await f.call('import', Buffer.from('not-a-memory-file'))
  assert.equal(imported.status, 400)
  assert.deepEqual(f.repos.counts(), before)
  const bad = await f.call('connect', JSON.stringify({ secretKey: 'private-secret' }))
  assert.equal(bad.status, 400)
  assert.ok(!(await bad.text()).includes('private-secret'))
})

test('the served page script actually executes export and import button workflows against the HTTP API', async t => {
  const f = await setup(t)
  const elements = new Map()
  const element = () => ({ textContent: '', value: '', files: [], children: [], hidden: false,
    replaceChildren(...children) { this.children = children }, click() { this.clicked = true } })
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  const context = vm.createContext({ document: { getElementById: get, createElement: element }, Date, JSON, Error,
    fetch: (url, options) => fetch(f.origin + url, { ...options, headers: { ...options.headers, origin: f.origin } }),
    setInterval() {}, console })
  const script = /<script>([\s\S]*?)<\/script>/.exec(f.page)[1]
  new vm.Script(script).runInContext(context)
  await get('export').onclick()
  assert.match(get('message').textContent, /记忆已导出/)
  const download = get('download').children[0]
  assert.equal(download.clicked, true)
  const bytes = await (await fetch(f.origin + download.href)).arrayBuffer()
  get('file').files = [{ size: bytes.byteLength, arrayBuffer: async () => bytes }]
  await get('import').onclick()
  assert.match(get('message').textContent, /导入完成/)
  await get('sync').onclick()
  assert.match(get('message').textContent, /请先连接/)
})
