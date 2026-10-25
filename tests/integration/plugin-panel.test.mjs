import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { MemoryTransfer } from '../../lib/cloud/memory-transfer.js'
import { createTransferHandler } from '../../lib/cloud/transfer-ui.js'
import { PluginPanel } from '../../lib/panel/controller.js'
import { loadPanelSettings } from '../../lib/panel/settings.js'
import { mountPanelEntry } from '../../lib/panel/entry.js'
import { companionInterests } from '../../lib/proactive/interests.js'

async function setup(t) {
  const f = fixture()
  const config = structuredClone(f.config)
  config.storage.directory = f.directory
  const owner = new OwnerIdentity(f.repos, config, f.now(), 'panel-device')
  const binding = owner.binding('desktop', 'panel-session', 'panel-device', f.now())
  const other = owner.binding('desktop', 'other-role', 'panel-device', f.now(), { id: 'other-role', preset: 'gentle' })
  const transfer = new MemoryTransfer(f.db, config, owner.deviceId)
  transfer.start()
  let changes = 0, scans = 0, previews = 0, paused = false
  const panel = new PluginPanel({ config, db: f.db, repos: f.repos, owner,
    commands: { config, db: f.db, repos: f.repos, updater: f.updater, retriever: f.retriever, metrics: f.metrics, scheduler: { status: () => ({}), setEnabled: value => { config.proactive.enabled = value } } },
    computer: { status: () => ({ running: false, sampling: false, supported: true, lastSampleAtMs: null, error: null, snapshot: null }), recent: () => [] },
    activeTargets: () => [binding], status: () => ({ counts: f.repos.counts() }), settingsChanged: () => { changes++ },
    scan: async () => ({ scans: ++scans }), preview: async () => ({ text: `草稿 ${++previews}`, previewOnly: true }),
    background: { start: () => { paused = false }, stop: () => { paused = true }, stats: () => ({ paused }) },
    review: { begin: () => 'review-begin', end: () => 'review-end' },
  })
  const handler = createTransferHandler(transfer, panel)
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await transfer.stop(); f.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const page = await (await fetch(origin + '/companion-memory/manage')).text()
  const token = JSON.parse(/const token=("[^"\n]+")/.exec(page)[1])
  const call = (route, body, extra = {}) => fetch(origin + '/companion-memory/api/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'x-companion-token': token, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const action = (action, data = {}) => call('panel-action', { action, conversationId: binding.conversationId, ...data })
  return { ...f, config, owner, binding, other, panel, origin, page, call, action, changes: () => changes }
}

test('panel lists only the current owner roles, preserves role isolation and rejects cross origin or unconfirmed actions', async t => {
  const f = await setup(t)
  const before = f.repos.counts()
  const state = await (await f.call('panel')).json()
  assert.equal(state.selected, f.binding.conversationId)
  assert.equal(state.conversations.length, 2)
  assert.ok(!state.conversations.some(row => row.id === 'c'), 'unowned private conversation is excluded')
  assert.deepEqual(f.repos.counts(), before, 'reading the panel creates no conversation or memory')
  assert.equal((await f.call('panel?conversationId=c')).status, 400)
  assert.equal((await f.call('panel', undefined, { origin: 'https://hostile.invalid' })).status, 403)
  assert.equal((await f.action('reset-relationship')).status, 400)
  assert.equal((await f.action('remember', { text: '喜欢安静地看星星' })).status, 200)
  const own = await (await f.call(`panel?conversationId=${f.binding.conversationId}`)).json()
  assert.ok(own.memories.some(row => row.claim.includes('星星')))
  const other = await (await f.call(`panel?conversationId=${f.other.conversationId}`)).json()
  assert.equal(other.memories.length, 0)
  const id = own.memories[0].id
  assert.equal((await f.action('forget', { id })).status, 400)
  assert.equal(f.repos.getMemory(id).status, 'active')
  assert.equal((await f.action('forget', { id, confirmed: true })).status, 200)
  assert.notEqual(f.repos.getMemory(id)?.status, 'active')
})

test('settings take effect immediately and reload locally, invalid settings cannot partially apply', async t => {
  const f = await setup(t)
  assert.equal((await f.action('settings', { settings: { proactive: { adaptiveMaxDailyLimit: 5, modelInterests: ['天文'] }, computerEvents: { foregroundApplications: true } } })).status, 200)
  assert.equal(f.config.proactive.adaptiveMaxDailyLimit, 5)
  assert.equal(f.changes(), 1)
  const restored = structuredClone(f.config)
  restored.proactive.modelInterests = []
  loadPanelSettings(f.repos, restored)
  assert.deepEqual(companionInterests(f.repos, restored, f.binding.principalId), ['天文'])
  assert.deepEqual(companionInterests(f.repos, restored, f.other.principalId), [])
  const before = JSON.stringify(f.config)
  for (const settings of [{ storage: { directory: 'x' } }, { proactive: { modelInterests: ['changed'], adaptiveMaxDailyLimit: 1.5 } }, { computerEvents: { collectScreen: true } }, { proactive: { shareSources: ['file:///secret'] } }]) {
    assert.equal((await f.action('settings', { settings })).status, 400)
    assert.equal(JSON.stringify(f.config), before)
  }
})

test('saving role interests without any owner conversation gives a useful error and creates no hidden fallback role', async t => {
  const f = fixture()
  t.after(() => f.close())
  const owner = new OwnerIdentity(f.repos, f.config)
  const panel = new PluginPanel({ config: structuredClone(f.config), db: f.db, repos: f.repos, owner, activeTargets: () => [] })
  const before = f.repos.counts()
  await assert.rejects(panel.action({ action: 'settings', settings: { proactive: { modelInterests: ['天文'] } } }), /请先在 DSH/)
  assert.deepEqual(f.repos.counts(), before)
  assert.equal(f.repos.getSetting(`proactive.model-interests:${owner.principalId}`), undefined)
})

test('graphical reminder, personality, maintenance and preview actions execute real application handlers', async t => {
  const f = await setup(t)
  const state = () => f.panel.snapshot({ conversationId: f.binding.conversationId })
  await f.action('task-add', { text: '明天下午喝水', dueAtMs: Date.now() + 3600000 })
  assert.equal(state().tasks[0].status, 'confirmed')
  const id = state().tasks[0].id
  await f.action('task-cancel', { id })
  assert.equal(state().tasks[0].status, 'cancelled')
  await f.action('personality-set', { traits: { socialEnergy: .9, playfulness: .8 } })
  assert.equal(state().profile.traits.socialEnergy, .9)
  assert.equal(state().profile.traits.playfulness, .8)
  await f.action('proactive-on')
  assert.equal(f.repos.getSetting('proactive.enabled'), '1')
  const before = f.db.get('SELECT COUNT(*) AS n FROM outbox').n
  assert.equal((await (await f.action('preview')).json()).previewOnly, true)
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM outbox').n, before)
  await f.action('background-pause'); assert.equal(state().background.paused, true)
  await f.action('background-resume'); assert.equal(state().background.paused, false)
  const backup = await (await f.action('backup')).json()
  assert.ok(backup.backup)
  await f.action('proactive-off'); assert.equal(f.repos.getSetting('proactive.enabled'), '0')
})

function pageDom(html) {
  const elements = new Map(), commands = []
  const element = tag => ({ tag, textContent: '', value: '', checked: false, hidden: false, files: [], dataset: {}, children: [],
    set id(value) { this.identifier = value; elements.set(value, this) }, get id() { return this.identifier },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? '' },
    append(...children) { this.children.push(...children); if (tag === 'select' && !this.value) this.value = children[0]?.value ?? '' },
    addEventListener() {}, click() { this.clicked = true } })
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) { const e = element(match[1]); e.id = match[2] }
  for (const match of html.matchAll(/<button[^>]*class="[^"]*command[^"]*"[^>]*data-action="([^"]+)"[^>]*>/g)) { const e = element('button'); e.dataset.action = match[1]; commands.push(e) }
  return { elements, commands, document: { getElementById: id => elements.get(id), createElement: element, querySelectorAll: selector => selector === '.command' ? commands : [] } }
}

test('served full panel JavaScript renders and drives memory, settings, reminder and confirmation workflows over HTTP', async t => {
  const f = await setup(t)
  const dom = pageDom(f.page), get = id => { assert.ok(dom.elements.has(id), `missing element ${id}`); return dom.elements.get(id) }
  let confirm = false
  const context = vm.createContext({ document: dom.document, window: { confirm: () => confirm }, Date, JSON, Error, encodeURIComponent,
    fetch: (url, options) => fetch(f.origin + url, { ...options, headers: { ...options.headers, origin: f.origin } }), setInterval() {} })
  new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(f.page)[1]).runInContext(context)
  await vm.runInContext('refresh()', context)
  assert.match(get('panel-summary').textContent, /好感/)
  assert.ok(!get('panel-summary').textContent.includes('NaN'))
  assert.equal(get('trait-inputs').children.length, 12)
  get('remember-text').value = '请记住我喜欢星空'
  await get('remember').onclick()
  assert.ok(f.panel.snapshot().memories.some(row => row.claim.includes('星空')))
  get('model-interests').value = '天文\n独立游戏'
  await get('save-settings').onclick()
  assert.deepEqual(f.panel.snapshot().proactive.modelInterests, ['天文', '独立游戏'])
  get('reminder-text').value = '喝水'
  get('reminder-time').value = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
  await get('reminder-add').onclick()
  assert.equal(f.panel.snapshot().tasks.length, 1)
  const forgetButton = get('memory-list').children[0].children.find(e => e.tag === 'button')
  await forgetButton.onclick()
  assert.equal(f.panel.snapshot().memories.length, 1, 'declining confirmation sends no deletion')
  confirm = true
  await forgetButton.onclick()
  assert.equal(f.panel.snapshot().memories.length, 0)
  assert.equal((await f.action('unknown')).status, 400)
})

test('official host injection publishes a persistent graphical entry, follows late web server readiness and disposes safely', t => {
  const f = fixture()
  t.after(() => f.close())
  let listener, ready, origin
  const ctx = { on: (name, fn) => { assert.equal(name, 'webserver/index-inject'); listener = fn; return () => { listener = undefined } }, get: name => name === 'appReady' ? { onReady: fn => { ready = fn; return () => { ready = undefined } } } : undefined }
  const dispose = mountPanelEntry(ctx, f.directory, () => { if (!origin) throw Error('not bound yet'); return origin })
  assert.equal(existsSync(join(f.directory, 'control-panel.json')), false)
  origin = 'http://127.0.0.1:12345'
  ready()
  const descriptor = JSON.parse(readFileSync(join(f.directory, 'control-panel.json'), 'utf8'))
  assert.equal(descriptor.url, origin + '/companion-memory/manage')
  assert.ok(!JSON.stringify(descriptor).includes('token'))
  const rows = []; listener(rows)
  assert.equal(rows[0].kind, 'html')
  assert.equal(rows[0].placement, 'body')
  assert.match(rows[0].html, /插件控制台/)
  assert.match(rows[0].html, /href="http:\/\/127\.0\.0\.1:12345\/companion-memory\/manage"/)
  dispose()
  assert.equal(listener, undefined)
  assert.equal(existsSync(join(f.directory, 'control-panel.json')), false)
})
