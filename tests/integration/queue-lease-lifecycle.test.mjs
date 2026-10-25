/**
 * 后台长任务租约生命周期回归（ROUND2-LEASE）。
 *
 * 背景：`tick()` 以前一次领满 batch 条再串行跑。第一条长任务超过 leaseMs 之后，
 *   · 还没开始的第 2..n 条也一起过期，被另一个 worker 重领（它们没执行过，却烧掉一次预算）；
 *   · 旧 handler 结束后仍然无条件 finishJob / 重排，直接覆盖新 worker 的状态；
 *   · stop() 之后 tick 仍会把已经领到的那批跑完。
 *
 * 现在守的不变量：
 *   1. 每次只领一条；未开始的任务不背租约；
 *   2. handler 运行期间周期续租，长任务不会被判成孤儿、不会被重复执行；
 *   3. 续租 / 完成 / 失败重排都是 `id + status='leased' + attempts` 条件更新，
 *      租约被接管后旧 worker 的成功与异常都落空；
 *   4. stop() 之后不再领下一条，正在跑的那条正常收尾；
 *   5. 库关闭时定时器不再写库，失败路径也会清掉续租计时器。
 *
 * 运行：node --test tests/integration/queue-lease-lifecycle.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixture } from '../helpers/fixture.mjs'
import { openDatabase } from '../../lib/storage/database.js'
import { Repositories } from '../../lib/storage/repositories.js'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(5)
  }
  return false
}

function options(clock, extra = {}) {
  return { tickMs: 60_000, leaseMs: 5_000, batch: 2, maxRetries: 3, now: () => clock.now, ...extra }
}

test('长任务靠续租保活：过期时间被推后，另一个 worker 不会重复执行', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const a = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 40 }))
  // 第二个 worker 走**独立连接**（同一个库文件，WAL + busy_timeout），
  // 验的是真实 SQLite 跨连接行为，而不是共享同一个 repos 实例的假象。
  const db2 = openDatabase({ ...f.config.storage, directory: f.directory }, false, 'fixture')
  const b = new BackgroundQueue(new Repositories(db2), f.metrics, options(clock, { renewEveryMs: 40 }))
  const started = deferred()
  const gate = deferred()
  let runs = 0
  const handler = async () => { runs += 1; started.resolve(); await gate.promise }
  a.register('backup', handler)
  b.register('backup', handler)

  const id = 'backup:long'
  assert.equal(a.enqueue('backup', {}, { dedupKey: 'long', availableAtMs: clock.now, nowMs: clock.now }), true)
  const running = a.tick(clock.now)
  await started.promise

  const claimed = f.repos.db.get('SELECT status, attempts, lease_until_ms FROM background_jobs WHERE id = ?', id)
  assert.equal(claimed.status, 'leased')
  assert.equal(claimed.attempts, 1)
  assert.equal(claimed.lease_until_ms, clock.now + 5_000)

  // 越过原租约终点：没有续租的话，这一行就是「孤儿」，会被第二个 worker 重领。
  clock.now += 6_000
  assert.equal(await waitFor(() => f.repos.db.get('SELECT lease_until_ms FROM background_jobs WHERE id = ?', id).lease_until_ms === clock.now + 5_000), true,
    'handler 运行期间必须按 renewEveryMs 续租')
  assert.equal(a.reclaimOrphans(clock.now), 0, '活租约不能被当孤儿回收')
  await b.tick(clock.now)
  assert.equal(runs, 1, '租约仍在，第二个 worker 不能重复执行')
  assert.equal(f.repos.db.get('SELECT attempts FROM background_jobs WHERE id = ?', id).attempts, 1, '重复执行会多烧一次重试预算')

  gate.resolve()
  await running
  const done = f.repos.db.get('SELECT status, attempts, lease_until_ms FROM background_jobs WHERE id = ?', id)
  assert.equal(done.status, 'done')
  assert.equal(done.attempts, 1)
  assert.equal(done.lease_until_ms, null)
  assert.equal(a.stats().doneTotal, 1)
  assert.equal(a.stats().staleTotal, 0)
  assert.equal(a.stats().activeLeases, 0)
  a.stop(); b.stop(); db2.close(); f.close()
})

test('每次只领一条：第一条长任务运行期间，第二条仍是 pending 且没被租走', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const queue = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 40 }))
  const started = deferred()
  const gate = deferred()
  const order = []
  let runningId = null
  queue.register('backup', async job => {
    order.push(job.id)
    runningId = job.id
    if (order.length === 1) { started.resolve(); await gate.promise }
  })

  queue.enqueue('backup', {}, { dedupKey: 'one', availableAtMs: clock.now, nowMs: clock.now })
  queue.enqueue('backup', {}, { dedupKey: 'two', availableAtMs: clock.now, nowMs: clock.now })
  const running = queue.tick(clock.now)
  await started.promise

  const others = f.repos.db.all('SELECT id, status, attempts FROM background_jobs WHERE id <> ?', runningId)
  assert.equal(others.length, 1)
  assert.equal(others[0].status, 'pending', '还没开始的任务不能提前进入 leased')
  assert.equal(others[0].attempts, 0, '整批预领会让它白烧一次重试预算')

  gate.resolve()
  await running
  assert.equal(order.length, 2, '第一条结束后同一 tick 继续领下一条')
  assert.deepEqual(f.repos.jobStats(), { done: 2 })
  queue.stop(); f.close()
})

test('stop 之后不再领下一条：正在跑的那条正常收尾，排队的不启动', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const queue = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 40 }))
  const started = deferred()
  const gate = deferred()
  const order = []
  queue.register('backup', async job => {
    order.push(job.id)
    if (order.length === 1) { started.resolve(); await gate.promise }
  })
  queue.enqueue('backup', {}, { dedupKey: 'first', availableAtMs: clock.now, nowMs: clock.now })
  queue.enqueue('backup', {}, { dedupKey: 'second', availableAtMs: clock.now, nowMs: clock.now })

  const running = queue.tick(clock.now)
  await started.promise
  queue.stop()
  gate.resolve()
  await running

  assert.equal(order.length, 1, 'stop 后不允许再启动新 handler')
  const pending = f.repos.db.get("SELECT status, attempts FROM background_jobs WHERE dedup_key = 'second'")
  assert.equal(pending.status, 'pending')
  assert.equal(pending.attempts, 0)
  await queue.tick(clock.now)
  assert.equal(order.length, 1, 'stop 后 tick 直接返回')
  f.close()
})

test('租约过期被重领后，旧 handler 的成功回写落空，不覆盖新状态', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  // 这两个 worker 故意不续租：让租约像崩溃一样过期，由第二个 worker 接管。
  const a = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 60_000 }))
  const b = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 60_000 }))
  const started = deferred()
  const gate = deferred()
  a.register('backup', async () => { started.resolve(); await gate.promise })
  b.register('backup', async () => { throw new Error('B 接管后失败') })

  const id = 'backup:takeover'
  a.enqueue('backup', {}, { dedupKey: 'takeover', availableAtMs: clock.now, nowMs: clock.now })
  const runningA = a.tick(clock.now)
  await started.promise
  assert.equal(f.repos.db.get('SELECT attempts FROM background_jobs WHERE id = ?', id).attempts, 1)

  // 模拟租约过期（不靠真实时间）：把过期时间压到过去。
  f.repos.db.run('UPDATE background_jobs SET lease_until_ms = 0 WHERE id = ?', id)
  await b.tick(clock.now)
  const takenOver = f.repos.db.get('SELECT status, attempts, last_error FROM background_jobs WHERE id = ?', id)
  assert.equal(takenOver.attempts, 2, '第二个 worker 重领后 attempts 前进')
  assert.equal(takenOver.status, 'pending', 'B 失败后按预算重排')
  assert.match(String(takenOver.last_error), /B 接管后失败/)

  // 旧 handler 现在才「成功」返回：CAS 必须落空。
  gate.resolve()
  await runningA
  const after = f.repos.db.get('SELECT status, attempts, last_error FROM background_jobs WHERE id = ?', id)
  assert.equal(after.status, 'pending', '旧 worker 不能把新 worker 的重排覆盖成 done')
  assert.equal(after.attempts, 2)
  assert.match(String(after.last_error), /B 接管后失败/)
  assert.equal(a.stats().doneTotal, 0)
  assert.equal(a.stats().staleTotal, 1, '落空要计入 stale，而不是算成功')
  a.stop(); b.stop(); f.close()
})

test('租约过期被重领后，旧 handler 的异常也不能改写新状态', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const a = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 60_000 }))
  const b = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 60_000 }))
  const started = deferred()
  const gate = deferred()
  a.register('backup', async () => { started.resolve(); await gate.promise; throw new Error('A 迟到的失败') })
  b.register('backup', async () => { throw new Error('B 接管后失败') })

  const id = 'backup:takeover-fail'
  a.enqueue('backup', {}, { dedupKey: 'takeover-fail', availableAtMs: clock.now, nowMs: clock.now })
  const runningA = a.tick(clock.now)
  await started.promise
  f.repos.db.run('UPDATE background_jobs SET lease_until_ms = 0 WHERE id = ?', id)
  await b.tick(clock.now)
  assert.equal(f.repos.db.get('SELECT attempts FROM background_jobs WHERE id = ?', id).attempts, 2)

  gate.resolve()
  await runningA
  const after = f.repos.db.get('SELECT status, attempts, last_error, available_at_ms FROM background_jobs WHERE id = ?', id)
  assert.equal(after.status, 'pending')
  assert.equal(after.attempts, 2, '旧 worker 不能把 attempts 改回去')
  assert.match(String(after.last_error), /B 接管后失败/, '旧 worker 的异常不能覆盖新 worker 的 last_error')
  assert.equal(a.stats().staleTotal, 1)
  // 统计边界：旧 worker 的异常因 CAS 落空而没改到自己的租约，只能算 stale。
  // 否则同一条任务会同时进 failedTotal 与 staleTotal，和 staleTotal 的语义冲突。
  assert.equal(a.stats().failedTotal, 0, '落空不能同时算一次失败')
  assert.equal(b.stats().failedTotal, 1, '真正改到自己租约的失败才计 failed')
  a.stop(); b.stop(); f.close()
})

test('长 handler 跑过退避窗口再失败：同一 tick 不能立刻重跑，退避从失败时刻算', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const queue = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 60_000 }))
  let runs = 0
  queue.register('backup', () => {
    runs += 1
    clock.now += 6_000 // handler 自己耗时 6s，远超首次退避的 1s
    throw new Error('长任务失败')
  })
  const id = 'backup:slow-fail'
  queue.enqueue('backup', {}, { dedupKey: 'slow-fail', availableAtMs: clock.now, nowMs: clock.now })
  const claimedAt = clock.now
  await queue.tick() // 不传 nowMs：走注入时钟，复现真实运行时的时序

  assert.equal(runs, 1, 'available_at 落在过去时，同一 tick 会立刻重跑一遍')
  const row = f.repos.db.get('SELECT status, attempts, available_at_ms FROM background_jobs WHERE id = ?', id)
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 1)
  const failedAt = claimedAt + 6_000
  assert.equal(row.available_at_ms, failedAt + 1_000, '退避从失败时刻算，不是从领取时刻算')
  assert.equal(row.available_at_ms > failedAt, true)
  queue.stop(); f.close()
})

test('显式 tick(nowMs) 保留传入的逻辑时间：handler 推进的增量叠在 nowMs 上', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const queue = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 60_000 }))
  let runs = 0
  queue.register('backup', () => {
    runs += 1
    clock.now += 6_000
    throw new Error('长任务失败')
  })
  const id = 'backup:slow-fail-explicit'
  queue.enqueue('backup', {}, { dedupKey: 'slow-fail-explicit', availableAtMs: clock.now, nowMs: clock.now })
  const logical = clock.now // 调用方给的逻辑时间与注入时钟同起点
  await queue.tick(logical)

  assert.equal(runs, 1, '显式 nowMs 不能被真实 Date.now 带跑')
  const row = f.repos.db.get('SELECT status, attempts, available_at_ms FROM background_jobs WHERE id = ?', id)
  assert.equal(row.attempts, 1)
  assert.equal(row.available_at_ms, logical + 6_000 + 1_000)
  queue.stop(); f.close()
})

test('数据库关闭后定时器不再写库，handler 收尾也不炸', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const queue = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 30 }))
  const started = deferred()
  const gate = deferred()
  queue.register('backup', async () => { started.resolve(); await gate.promise })
  queue.enqueue('backup', {}, { dedupKey: 'closed', availableAtMs: clock.now, nowMs: clock.now })

  const running = queue.tick(clock.now)
  await started.promise
  f.db.close()
  const renewalsAtClose = queue.stats().renewals
  gate.resolve()
  await running
  assert.equal(queue.stats().activeLeases, 0)
  await sleep(150)
  assert.equal(queue.stats().renewals, renewalsAtClose, '库关闭后续租计时器必须停写')
  queue.stop()
  f.close()
})

test('失败路径也清理续租计时器：不会残留一个还在改写租约的表', async () => {
  const f = fixture()
  const clock = { now: f.now() }
  const queue = new BackgroundQueue(f.repos, f.metrics, options(clock, { renewEveryMs: 30 }))
  queue.register('backup', () => { throw new Error('必失败') })
  const id = 'backup:leaky'
  queue.enqueue('backup', {}, { dedupKey: 'leaky', availableAtMs: clock.now, nowMs: clock.now })
  await queue.tick(clock.now)
  assert.equal(f.repos.db.get('SELECT status FROM background_jobs WHERE id = ?', id).status, 'pending')

  // 摆回「如果计时器泄漏，就会被它改写」的状态：同 id、同 attempts、已过期。
  f.repos.db.run("UPDATE background_jobs SET status = 'leased', attempts = 1, lease_until_ms = 0 WHERE id = ?", id)
  const before = queue.stats().renewals
  await sleep(150)
  assert.equal(f.repos.db.get('SELECT lease_until_ms FROM background_jobs WHERE id = ?', id).lease_until_ms, 0,
    'handler 结束后不允许再有续租写入')
  assert.equal(queue.stats().renewals, before)
  queue.stop(); f.close()
})
