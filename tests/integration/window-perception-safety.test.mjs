import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { OwnerIdentity } from '../../lib/domain/owner-identity.js'
import { WindowPerception } from '../../lib/runtime/window-perception.js'
import { observeComputerEvent } from '../../lib/proactive/computer-opportunities.js'

const window = { windowId: 17, processId: 18, app: 'notepad', startedAt: '639285728954710587', foreground: true, minimized: false }

function setup(t, options = {}) {
  const f = fixture({ config: { perception: { enabled: true, allowedApplications: ['notepad'], ...options.settings },
    ...(options.emotion ? { emotion: options.emotion } : {}) } })
  const owner = new OwnerIdentity(f.repos, f.config, f.now(), 'perception-device')
  const binding = owner.binding('dsh', 'perception-session', 'perception-device', f.now())
  const calls = [], events = []
  let reads = 0
  const native = {
    async list() { return { windows: [window] } },
    async read() {
      reads++
      return { window, facts: [{ text: 'Build failed', source: 'ocr', control: 'window-image' }],
        image: 'aGVsbG8=', redactionComplete: true, ...options.raw }
    },
  }
  const perception = new WindowPerception({ config: f.config, repos: f.repos, binding: () => binding, native, now: f.now,
    callModel: async function* (request) {
      calls.push(request)
      if (options.callModel) yield* options.callModel(request)
      else yield { text: '{"hypotheses":[]}' }
    },
    onEvent(event, target) { events.push({ event, target }); observeComputerEvent(f.repos, f.config, event, [target]) },
  })
  perception.configure()
  perception.setTarget(binding)
  t.after(() => { perception.stop(); f.close() })
  return { ...f, owner, binding, perception, native, calls, events, reads: () => reads }
}

function migrateConversation(f) {
  const ownerId = 'adopted-perception-owner', principalId = `${f.config.companion.id}:owner:${ownerId}`
  f.repos.ensurePrincipal(principalId, f.config.companion.id, 'owner', ownerId, f.now())
  f.db.run('UPDATE conversations SET principal_id = ? WHERE id = ?', principalId, f.binding.conversationId)
  f.repos.setSetting('owner.id', ownerId, f.now())
  return { ownerId, principalId }
}

test('a cached window target follows the conversation owner after pairing, including its observation, usage and opportunity', async t => {
  const f = setup(t)
  await f.perception.select(window.windowId)
  const adopted = migrateConversation(f)
  const observation = await f.perception.inspect(window.windowId, 'uia', true, true)
  assert.equal(observation.principalId, adopted.principalId)
  assert.equal(JSON.parse(f.repos.getSetting(`local.perception.observation:${observation.id}`)).principalId, adopted.principalId)
  assert.equal(f.events[0].target.principalId, adopted.principalId)
  assert.equal(f.events[0].target.userId, adopted.ownerId)
  assert.equal(f.db.get("SELECT principal_id FROM audit_events WHERE kind = 'model-usage:perception'").principal_id, adopted.principalId)
  assert.equal(f.db.get("SELECT principal_id FROM proactive_opportunities WHERE kind = 'computer_event'").principal_id, adopted.principalId)
  assert.deepEqual(f.db.all('PRAGMA foreign_key_check'), [])
})

test('an owner change during an in-flight analysis cannot publish or audit the old cached identity', async t => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const f = setup(t, { callModel: async function* () { entered(); await gate; yield { text: '{"hypotheses":[]}' } } })
  t.after(() => release())
  await f.perception.select(window.windowId)
  const work = f.perception.inspect(window.windowId, 'uia', true, true)
  await started
  const adopted = migrateConversation(f)
  release()
  const observation = await work
  assert.equal(observation.principalId, adopted.principalId)
  assert.equal(f.events[0].target.principalId, adopted.principalId)
  assert.equal(f.db.get("SELECT principal_id FROM audit_events WHERE kind = 'model-usage:perception'").principal_id, adopted.principalId)
})

test('revalidation revokes observations and pending opportunities whose conversation changed owner', async t => {
  const f = setup(t)
  await f.perception.select(window.windowId)
  const observation = await f.perception.inspect(window.windowId, 'uia', false, true)
  assert.ok(f.repos.getSetting(`local.computer-evidence:computer:${observation.id}`))
  migrateConversation(f)
  await f.perception.revalidate()
  assert.equal(f.repos.getSetting(`local.perception.observation:${observation.id}`), undefined)
  assert.equal(f.repos.getSetting(`local.computer-evidence:computer:${observation.id}`), undefined)
  assert.equal(f.db.get("SELECT status FROM proactive_opportunities WHERE kind = 'computer_event'").status, 'cancelled')
  assert.deepEqual(f.perception.status().recent, [])
})

test('a cached private binding cannot capture after its persisted conversation becomes ineligible', async t => {
  const f = setup(t)
  await f.perception.select(window.windowId)
  f.db.run("UPDATE conversations SET kind = 'group' WHERE id = ?", f.binding.conversationId)
  await assert.rejects(f.perception.inspect(window.windowId, 'uia', true, true), /会话/)
  assert.equal(f.reads(), 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.events.length, 0)
})

for (const redactionComplete of [undefined, false, 'true', 1]) {
  test(`an image without affirmative native masking completion (${String(redactionComplete)}) is never previewed, analyzed or persisted`, async t => {
    const f = setup(t, { settings: { allowCloudImages: true, allowHostImageStorage: true }, raw: { redactionComplete } })
    await f.perception.select(window.windowId)
    for (const analyze of [false, true]) await assert.rejects(f.perception.inspect(window.windowId, 'image', analyze, analyze), /遮挡/)
    assert.equal(f.calls.length, 0, 'Unverified masking must be rejected before the model can receive image or OCR text')
    assert.equal(f.events.length, 0)
    assert.deepEqual(f.perception.status().recent, [])
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM plugin_settings WHERE key LIKE 'local.perception.observation:%'").n, 0)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'model-usage:perception'").n, 0)
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM plugin_settings WHERE key LIKE 'local.perception.budget:%'").n, 0)
  })
}

test('a provider ignoring timeout cannot return its late image analysis, and remains busy until its real call finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const f = setup(t, { settings: { allowCloudImages: true, allowHostImageStorage: true }, emotion: { backgroundTimeoutMs: 1000 },
    callModel: async function* () { entered(); await gate; yield { text: '{"hypotheses":[{"text":"late result","quote":"Build failed","confidence":0.9}]}' } } })
  t.after(() => release())
  await f.perception.select(window.windowId)
  const work = f.perception.inspect(window.windowId, 'image', true, true)
  await started
  t.mock.timers.tick(1000)
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.perception.status().busy, true, 'Timeout must not unlock a provider that is still using its model slot')
  await assert.rejects(f.perception.inspect(window.windowId, 'image', true, true), /正在进行/)
  release()
  await assert.rejects(work, /超时|取消/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.perception.status().busy, false)
  assert.deepEqual(f.perception.status().recent, [])
  assert.equal(f.events.length, 0)
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM plugin_settings WHERE key LIKE 'local.perception.observation:%'").n, 0)
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM plugin_settings WHERE key LIKE 'local.computer-evidence:%'").n, 0)
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM proactive_opportunities WHERE kind = 'computer_event'").n, 0)
})
