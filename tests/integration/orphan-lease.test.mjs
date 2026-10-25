/**
 * 孤儿租约回归（P0-1）。
 *
 * 背景：`claimJobs()` 只认 `status = 'pending'`，`lease_until_ms` 写进去却从没被读过。
 * 进程崩在 handler 里（或 tick 里 `db.isOpen` 为假提前 return）之后，这一行会永久停在
 * `'leased'`：
 *   · 该任务永远不会再执行（提取任务=这段原文永远不产出记忆）；
 *   · `consolidation-scheduler.ts` 把 `status IN ('pending','leased')` 当成「已在排队」，
 *     于是这个会话的整理任务永久停摆，且没有任何报错。
 *
 * `background-queue.ts` 文件头第 7 行声称「进程崩了租约会自然过期，不产生永久锁」，
 * 这几条用例守的就是这个不变量；第三条另外守住「连续过期不能绕过 maxRetries」。
 *
 * 运行：node --test tests/integration/orphan-lease.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixture } from '../helpers/fixture.mjs'
import { BackgroundQueue } from '../../lib/runtime/background-queue.js'
import { scheduleConsolidation } from '../../lib/runtime/consolidation-scheduler.js'

test('过期租约会被重新认领：崩在 handler 里的任务不会永久停在 leased', async () => {
  const f = fixture()
  const queue = new BackgroundQueue(f.repos, f.metrics, { tickMs: 60_000, leaseMs: 5_000, batch: 2, maxRetries: 3 })
  let ran = 0
  queue.register('backup', () => { ran += 1 })
  const start = f.now()
  assert.equal(queue.enqueue('backup', {}, { dedupKey: 'orphan-1', availableAtMs: start, nowMs: start }), true)

  // 模拟「领到一半进程崩了」：领走之后永不 finishJob。
  assert.equal(f.repos.claimJobs(start, 5_000, 5).length, 1)
  assert.equal(f.repos.db.get("SELECT status FROM background_jobs WHERE kind = 'backup'")?.status, 'leased')

  // 租约未过期：另一个活进程正在跑，不能抢。
  await queue.tick(start + 1_000)
  assert.equal(ran, 0, 'a live lease must not be stolen')
  assert.equal(f.repos.db.get("SELECT status FROM background_jobs WHERE kind = 'backup'")?.status, 'leased')

  // 租约过期：孤儿必须被重新认领并执行。
  await queue.tick(start + 5_001)
  assert.equal(ran, 1, 'expired lease must be reclaimed instead of staying leased forever')
  assert.equal(f.repos.db.get("SELECT status FROM background_jobs WHERE kind = 'backup'")?.status, 'done')
  assert.equal(f.repos.db.get("SELECT lease_until_ms FROM background_jobs WHERE kind = 'backup'")?.lease_until_ms, null)
  f.close()
})

test('reclaimOrphans 只回收已过期的租约，并把停摆的整理调度放回来', async () => {
  const f = fixture()
  const queue = new BackgroundQueue(f.repos, f.metrics, { tickMs: 60_000, leaseMs: 5_000 })
  queue.register('consolidate', () => {})
  const now = f.now()

  assert.equal(scheduleConsolidation(f.repos, f.config, queue, 'c', 'p', now, { throughSeq: 3 }), true)
  assert.equal(scheduleConsolidation(f.repos, f.config, queue, 'c', 'p', now + 1, { throughSeq: 4 }), false, 'already queued')

  const later = now + 1_000
  assert.equal(f.repos.claimJobs(later, 5_000, 5).length, 1)
  assert.equal(queue.reclaimOrphans(later), 0, 'live lease must not be reclaimed')
  assert.equal(queue.reclaimOrphans(later + 5_001), 1)

  const row = f.repos.db.get("SELECT status, lease_until_ms FROM background_jobs WHERE kind = 'consolidate'")
  assert.equal(row.status, 'pending')
  assert.equal(row.lease_until_ms, null)
  f.close()
})

test('连续租约过期不会绕过重试上限：用尽预算后判终结失败，不再无限重启', async () => {
  const f = fixture()
  const maxRetries = 2
  const queue = new BackgroundQueue(f.repos, f.metrics, { tickMs: 60_000, leaseMs: 5_000, maxRetries })
  const budget = maxRetries + 1
  let now = f.now()
  assert.equal(queue.enqueue('backup', {}, { dedupKey: 'poison', availableAtMs: now, nowMs: now }), true)

  // 每一轮：领走 → 进程在租约内死掉 → 租约过期被回收。
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    assert.equal(f.repos.claimJobs(now, 5_000, 1).length, 1, `第 ${attempt} 次仍应被认领（预算内）`)
    now += 5_001
    queue.reclaimOrphans(now)
  }

  const row = f.repos.db.get("SELECT status, attempts, lease_until_ms FROM background_jobs WHERE kind = 'backup'")
  assert.equal(row.attempts, budget, 'attempts 不应超过预算')
  assert.equal(row.status, 'failed', '用尽预算后必须判终结失败，而不是一直重排')
  assert.equal(row.lease_until_ms, null)
  assert.equal(f.repos.claimJobs(now + 60_000, 5_000, 1).length, 0, '终结失败后不再被认领')
  f.close()
})
