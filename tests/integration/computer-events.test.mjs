import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputerEvents, deriveEvents } from '../../lib/runtime/computer-events.js'

const BASE_SETTINGS = {
  enabled: true,
  pollSeconds: 60,
  idleThresholdSeconds: 300,
  foregroundApplications: true,
  resources: true,
  network: true,
  watchDirectories: []
}

function snap(overrides = {}) {
  return {
    sampledAtMs: 1_000_000,
    idleSeconds: 5,
    foregroundApp: 'Code.exe',
    networkOnline: true,
    batteryPercent: 80,
    cpuPercent: 10,
    memoryPercent: 40,
    ...overrides
  }
}

function harness(settingsOverrides = {}) {
  const events = []
  let settings = { ...BASE_SETTINGS, ...settingsOverrides }
  let current = null
  let clock = 1_000_000
  let probes = 0
  const instance = new ComputerEvents({
    settings: () => ({ ...settings }),
    onEvent: event => events.push(event),
    now: () => clock,
    readSnapshot: async () => { probes += 1; if (current instanceof Error) throw current; return current }
  })
  return {
    instance,
    events,
    get probes() { return probes },
    setSnapshot(value) { current = value },
    setError(value) { current = value },
    setClock(value) { clock = value },
    setSettings(next) { settings = { ...settings, ...next } }
  }
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) { resolve(true); return }
      if (Date.now() - started > timeoutMs) { reject(new Error('等待超时')); return }
      setTimeout(tick, 50)
    }
    tick()
  })
}

test('首次采样只是基线，不产生任何事件', async () => {
  const h = harness()
  h.setSnapshot(snap({ foregroundApp: 'Code.exe', idleSeconds: 400 }))
  const first = await h.instance.sample()
  assert.ok(first)
  assert.deepEqual(h.events, [])
  assert.equal(h.instance.status().lastSampleAtMs, 1_000_000)
})

test('前台应用切换只发一次，重复采样不重复发', async () => {
  const h = harness()
  h.setSnapshot(snap({ foregroundApp: 'Code.exe' }))
  await h.instance.sample()
  h.setClock(1_060_000)
  h.setSnapshot(snap({ sampledAtMs: 1_060_000, foregroundApp: 'chrome.exe' }))
  await h.instance.sample()
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'foreground_app_changed')
  assert.equal(h.events[0].details.previous, 'Code.exe')
  assert.equal(h.events[0].details.current, 'chrome.exe')
  await h.instance.sample()
  assert.equal(h.events.length, 1)
})

test('前台应用为 unknown 时不伪造切换事件', async () => {
  const h = harness()
  h.setSnapshot(snap({ foregroundApp: 'Code.exe' }))
  await h.instance.sample()
  h.setSnapshot(snap({ foregroundApp: null }))
  await h.instance.sample()
  h.setSnapshot(snap({ foregroundApp: 'Code.exe' }))
  await h.instance.sample()
  assert.deepEqual(h.events, [])
})

test('idle_return 只认“检测到输入”的真实下降，不用经过时间冒充', async () => {
  const h = harness()
  h.setSnapshot(snap({ idleSeconds: 400 }))
  await h.instance.sample()
  h.setClock(1_060_000)
  h.setSnapshot(snap({ sampledAtMs: 1_060_000, idleSeconds: 402 }))
  await h.instance.sample()
  assert.deepEqual(h.events, [], '空闲时长继续上升不能算唤醒')
  h.setClock(1_120_000)
  h.setSnapshot(snap({ sampledAtMs: 1_120_000, idleSeconds: 6 }))
  await h.instance.sample()
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'idle_return')
  assert.equal(h.events[0].details.idleSeconds, 6)
})

test('空闲时长从阈值下方回升不产生 idle_return', async () => {
  const h = harness()
  h.setSnapshot(snap({ idleSeconds: 120 }))
  await h.instance.sample()
  h.setSnapshot(snap({ idleSeconds: 3 }))
  await h.instance.sample()
  assert.deepEqual(h.events, [])
})

test('网络恢复是边沿事件，持续在线不重复触发', async () => {
  const h = harness()
  h.setSnapshot(snap({ networkOnline: false }))
  await h.instance.sample()
  h.setSnapshot(snap({ networkOnline: true }))
  await h.instance.sample()
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'network_restored')
  await h.instance.sample()
  assert.equal(h.events.length, 1)
  h.setSnapshot(snap({ networkOnline: false }))
  await h.instance.sample()
  h.setSnapshot(snap({ networkOnline: true }))
  await h.instance.sample()
  assert.equal(h.events.filter(event => event.kind === 'network_restored').length, 2)
})

test('电量偏低带滞回：低电量只报一次，恢复后可再次触发', async () => {
  const h = harness()
  h.setSnapshot(snap({ batteryPercent: 60 }))
  await h.instance.sample()
  h.setSnapshot(snap({ batteryPercent: 18 }))
  await h.instance.sample()
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'battery_low')
  h.setSnapshot(snap({ batteryPercent: 15 }))
  await h.instance.sample()
  assert.equal(h.events.length, 1, '仍然偏低时不得刷屏')
  h.setSnapshot(snap({ batteryPercent: 45 }))
  await h.instance.sample()
  assert.equal(h.events.length, 1, '恢复不算事件')
  h.setSnapshot(snap({ batteryPercent: 12 }))
  await h.instance.sample()
  assert.equal(h.events.filter(event => event.kind === 'battery_low').length, 2)
})

test('资源紧张带滞回：CPU/内存越界各触发一次，回落后可重触发', async () => {
  const h = harness()
  h.setSnapshot(snap({ cpuPercent: 10, memoryPercent: 30 }))
  await h.instance.sample()
  h.setSnapshot(snap({ cpuPercent: 92, memoryPercent: 30 }))
  await h.instance.sample()
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'resource_pressure')
  h.setSnapshot(snap({ cpuPercent: 88, memoryPercent: 30 }))
  await h.instance.sample()
  assert.equal(h.events.length, 1, '仍在压力区不得刷屏')
  h.setSnapshot(snap({ cpuPercent: 20, memoryPercent: 30 }))
  await h.instance.sample()
  h.setSnapshot(snap({ cpuPercent: 20, memoryPercent: 95 }))
  await h.instance.sample()
  assert.equal(h.events.filter(event => event.kind === 'resource_pressure').length, 2)
})

test('开关关闭时不探测、sample 返回 null', async () => {
  const h = harness({ enabled: false })
  h.setSnapshot(snap())
  assert.equal(await h.instance.sample(), null)
  assert.equal(h.probes, 0)
  h.instance.start()
  assert.equal(h.instance.status().running, false)
})

test('disabled categories leave no values in the exposed snapshot', async () => {
  const h = harness({ foregroundApplications: false, resources: false, network: false })
  h.setSnapshot(snap())
  const snapshot = await h.instance.sample()
  for (const key of ['foregroundApp', 'cpuPercent', 'memoryPercent', 'batteryPercent', 'networkOnline']) assert.equal(snapshot[key], null)
  assert.equal(snapshot.idleSeconds, 5)
})

test('baseline already low or overloaded is not reported as a later new event', async () => {
  const h = harness()
  h.setSnapshot(snap({ batteryPercent: 10, cpuPercent: 95 }))
  await h.instance.sample()
  await h.instance.sample()
  assert.deepEqual(h.events, [])
})

test('restart resets the baseline, and concurrent manual samples cannot race', async t => {
  let finish, probes = 0
  const h = new ComputerEvents({ settings: () => ({ ...BASE_SETTINGS, pollSeconds: 3600 }), onEvent: () => assert.fail('restart baseline must not emit'), readSnapshot: async () => { probes++; return new Promise(resolve => { finish = resolve }) } })
  t.after(() => h.stop())
  const first = h.sample()
  assert.equal(await h.sample(), null)
  assert.equal(probes, 1)
  finish(snap({ foregroundApp: 'first' })); await first
  h.stop(); h.start()
  await waitFor(() => probes === 2, 3000)
  finish(snap({ foregroundApp: 'second' }))
  await waitFor(() => !h.status().sampling, 3000)
  assert.equal(h.status().snapshot.foregroundApp, 'second')
})

test('stop() 之后飞行中的采样不得再发事件', async () => {
  const events = []
  let resolveProbe = () => {}
  const instance = new ComputerEvents({
    settings: () => ({ ...BASE_SETTINGS }),
    onEvent: event => events.push(event),
    now: () => 2_000_000,
    readSnapshot: () => new Promise(resolve => { resolveProbe = resolve })
  })
  const inFlight = instance.sample()
  instance.stop()
  resolveProbe(snap({ sampledAtMs: 2_000_000, foregroundApp: 'other.exe' }))
  assert.equal(await inFlight, null)
  assert.deepEqual(events, [])
  assert.equal(instance.status().running, false)
})

test('探针报错对外只给固定中文，不泄漏原始输出', async () => {
  const h = harness()
  h.setError(new Error('powershell.exe : 拒绝访问 C:\\Users\\secret\\token.txt'))
  assert.equal(await h.instance.sample(), null)
  assert.equal(h.instance.status().error, '系统查询失败')
  assert.ok(!JSON.stringify(h.instance.status()).includes('token.txt'))
})

test('超时错误保留可读文案', async () => {
  const h = harness()
  h.setError(new Error('系统查询超时'))
  assert.equal(await h.instance.sample(), null)
  assert.equal(h.instance.status().error, '系统查询超时')
})

test('recent() 最多保留 30 条', async () => {
  const h = harness()
  h.setSnapshot(snap({ networkOnline: false, foregroundApp: 'Code.exe' }))
  await h.instance.sample()
  for (let index = 1; index <= 40; index += 1) {
    h.setSnapshot(snap({ networkOnline: index % 2 === 0, foregroundApp: `app-${index}.exe` }))
    await h.instance.sample()
  }
  assert.equal(h.instance.recent().length, 30)
  const recent = h.instance.recent()
  assert.equal(recent.at(-2).details.current, 'app-40.exe')
  assert.equal(recent.at(-1).kind, 'network_restored')
})

test('deriveEvents 对基线返回空，且不读全局状态', () => {
  assert.deepEqual(deriveEvents(null, snap(), BASE_SETTINGS, { batteryLow: false, resourcePressure: false }), [])
})

test('显式目录监听：报告 basename、跳过私密噪声、stop 后不再触发', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-computer-events-'))
  const events = []
  const instance = new ComputerEvents({
    settings: () => ({ ...BASE_SETTINGS, watchDirectories: [directory], pollSeconds: 3600 }),
    onEvent: event => events.push(event),
    readSnapshot: async () => snap({ sampledAtMs: Date.now() })
  })
  t.after(() => { instance.stop(); rmSync(directory, { recursive: true, force: true }) })
  instance.start()
  assert.equal(instance.status().running, true)
  await new Promise(resolve => setTimeout(resolve, 150))
  writeFileSync(join(directory, '.env'), 'SECRET=1')
  writeFileSync(join(directory, 'notes.txt'), 'hello')
  await waitFor(() => events.some(event => event.kind === 'file_changed'), 6000)
  const fileEvents = events.filter(event => event.kind === 'file_changed')
  assert.equal(fileEvents.length, 1, '只应报告一次去抖后的文件变化')
  assert.equal(fileEvents[0].details.file, 'notes.txt')
  assert.equal(fileEvents[0].details.directory, join(directory).split(/[\\/]/).at(-1))
  assert.ok(!JSON.stringify(fileEvents[0]).includes(directory), '事件里不得出现完整路径')
  assert.ok(!fileEvents.some(event => JSON.stringify(event).includes('.env')))
  instance.stop()
  writeFileSync(join(directory, 'later.txt'), 'x')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(events.filter(event => event.kind === 'file_changed').length, 1)
})

test('相对路径与缺失目录不会被监听', async t => {
  const instance = new ComputerEvents({
    settings: () => ({ ...BASE_SETTINGS, watchDirectories: ['relative/dir', join(tmpdir(), 'dsh-computer-events-missing')], pollSeconds: 3600 }),
    onEvent: () => {},
    readSnapshot: async () => snap()
  })
  t.after(() => instance.stop())
  instance.start()
  assert.equal(instance.status().running, true)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(instance.recent().length, 0)
})

test('Windows 真实探针：非交互返回快照，未知字段用 null 而不是编造', { skip: process.platform !== 'win32' }, async () => {
  const instance = new ComputerEvents({ settings: () => ({ ...BASE_SETTINGS }), onEvent: () => {} })
  assert.equal(instance.status().supported, true)
  const snapshot = await instance.sample()
  assert.ok(snapshot)
  assert.equal(typeof snapshot.sampledAtMs, 'number')
  assert.ok(snapshot.sampledAtMs > 0)
  assert.ok(snapshot.idleSeconds === null || Number.isFinite(snapshot.idleSeconds))
  assert.ok(snapshot.foregroundApp === null || typeof snapshot.foregroundApp === 'string')
  assert.ok(snapshot.batteryPercent === null || (snapshot.batteryPercent >= 0 && snapshot.batteryPercent <= 100))
  assert.ok(snapshot.memoryPercent === null || (snapshot.memoryPercent >= 0 && snapshot.memoryPercent <= 100))
  assert.ok(snapshot.networkOnline === null || typeof snapshot.networkOnline === 'boolean')
})
