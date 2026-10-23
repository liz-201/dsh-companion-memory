import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../../lib/config.js'
import { PRESETS } from '../../lib/domain/affect-reducer.js'
import { deleteScope } from '../../lib/storage/deletion.js'
import { openDatabase } from '../../lib/storage/database.js'
import { migrate } from '../../lib/storage/migrations.js'
import { Repositories } from '../../lib/storage/repositories.js'
import { FactUpdater, keyOf } from '../../lib/memory/fact-updater.js'
import { Retriever } from '../../lib/memory/retriever.js'

const config = resolveConfig()
const T0 = 1_760_000_000_000

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-memory-unit-'))
  const db = openDatabase({ ...config.storage, directory: dir }, true)
  migrate(db, { now: T0 })
  const repos = new Repositories(db)
  repos.ensureCompanion('dafeiyu', '大肥鱼', PRESETS.balanced, T0)
  const principal = repos.ensurePrincipal('p-1', 'dafeiyu', 'bot-1', 'user-1', T0)
  repos.ensureConversation('c-1', principal.id, 'private', 'private:user-1', T0)
  const message = (id, content, seq) =>
    repos.insertRawMessage({
      id,
      conversationId: 'c-1',
      platformMessageKey: `qq-${seq}`,
      role: 'user',
      sourceKind: 'qq',
      content,
      occurredAtMs: T0 + seq * 1000,
      observedAtMs: T0 + seq * 1000,
      deliveryStatus: 'delivered',
      deletedAtMs: null,
    })
  message('m-1', '我搬去重庆了', 1)
  message('m-2', '重庆这边火锅好吃', 2)
  const updater = new FactUpdater(repos, config.memory)
  return {
    dir,
    db,
    repos,
    updater,
    close() {
      db.close()
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        /* Windows 文件句柄延迟释放，测试目录可留待系统清理 */
      }
    },
  }
}

function candidate(over = {}) {
  return {
    id: 'mem-1',
    principalId: 'p-1',
    conversationId: 'c-1',
    visibility: 'private',
    kind: 'fact',
    subject: '住址',
    predicate: '城市',
    object: { value: '重庆' },
    claim: '用户住在重庆',
    sourceKind: 'qq',
    confidence: 0.9,
    salience: 0.8,
    eventAtMs: T0 + 1000,
    observedAtMs: T0 + 1000,
    evidence: [{ messageId: 'm-1', quote: '我搬去重庆了' }],
    ...over,
  }
}

test('事实写入 → 幂等 → 冲突 → 显式更新 → 撤回', () => {
  const fx = makeFixture()
  try {
    const first = fx.updater.write(candidate())
    assert.equal(first.type, 'inserted', JSON.stringify(first))

    const again = fx.updater.write(candidate())
    assert.equal(again.type, 'unchanged')
    assert.equal(again.reason, 'duplicate-evidence')

    const conflict = fx.updater.write(
      candidate({
        id: 'mem-2',
        object: { value: '成都' },
        claim: '用户住在成都',
        evidence: [{ messageId: 'm-2', quote: '重庆这边火锅好吃' }],
      }),
    )
    assert.equal(conflict.type, 'conflict', JSON.stringify(conflict))
    assert.deepEqual(conflict.conflictsWith, ['mem-1'])

    const updated = fx.updater.write(
      candidate({
        id: 'mem-3',
        object: { value: '成都' },
        claim: '用户住在成都',
        relation: 'updates',
        evidence: [{ messageId: 'm-2', quote: '重庆这边火锅好吃' }],
      }),
    )
    assert.equal(updated.type, 'inserted', JSON.stringify(updated))
    assert.deepEqual(updated.supersededIds, ['mem-1'])
    assert.notEqual(fx.repos.getMemory('mem-1').validToMs, null)

    const correction = fx.updater.retract('mem-3', '用户说记错了', T0 + 5000)
    assert.equal(correction.notFound, false)
    assert.ok(correction.retracted.includes('mem-3'))
    assert.equal(fx.repos.getMemory('mem-3').status, 'retracted')
  } finally {
    fx.close()
  }
})

test('检索：关键词命中、不相关不注入、被撤回的不返回', () => {
  const fx = makeFixture()
  try {
    fx.updater.write(candidate())
    const retriever = new Retriever(fx.repos, config.memory)
    const binding = {
      companionId: 'dafeiyu',
      botAccountId: 'bot-1',
      userId: 'user-1',
      conversationId: 'c-1',
      conversationKind: 'private',
      principalId: 'p-1',
      visibility: 'private',
    }
    const hit = retriever.retrieve({ binding, query: '你还记得我住哪吗', nowMs: T0 + 10_000 })
    assert.ok(hit.selected.some((item) => item.item.claim.includes('重庆')), JSON.stringify(hit.selected))
    assert.ok(hit.elapsedMs >= 0)

    const miss = retriever.retrieve({ binding, query: '今天天气怎么样', nowMs: T0 + 10_000 })
    assert.equal(miss.selected.length, 0, JSON.stringify(miss.selected))
  } finally {
    fx.close()
  }
})

test('删除范围：记忆与原文一起清掉，并留墓碑可回放', () => {
  const fx = makeFixture()
  try {
    fx.updater.write(candidate())
    const result = deleteScope(fx.db, fx.repos, 'p-1', { kind: 'memory', memoryId: 'mem-1' }, T0 + 20_000, 7)
    assert.ok(result.removedMemories.length >= 1, JSON.stringify(result))
    assert.equal(fx.repos.getMemory('mem-1'), undefined, '被删记忆不应还能按 id 取回')
    assert.ok(fx.repos.listTombstones('p-1').length >= 1, '删除必须留墓碑')
  } finally {
    fx.close()
  }
})

test('键规范化：空白与大小写不影响同桶', () => {
  assert.equal(keyOf('  住址 '), keyOf('住址'))
  assert.equal(keyOf('City'), keyOf('city'))
  assert.equal(keyOf(null), null)
})
