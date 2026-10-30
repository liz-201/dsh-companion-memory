import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { buildCandidates, checkGates } from '../../lib/proactive/candidate-builder.js'
import { ProactiveScheduler } from '../../lib/proactive/scheduler.js'

function raw(f, id, content) {
  return f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh', content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row
}
const gateInput = f => ({ repos: f.repos, config: f.config, conversationId: 'c', principalId: 'p', nowMs: f.now() })

test('idle talk: 没到 idleTalkMinutes 不产生闲聊候选', () => {
  const f = fixture()
  try {
    raw(f, 'a', '今天把插件跑通了')
    f.advance(60 * 60000)
    const built = buildCandidates(gateInput(f))
    assert.equal(built.candidates.length, 0)
    assert.equal(built.selected, null)
  } finally { f.close() }
})

test('idle talk: 超过 idleTalkMinutes 选中 small_talk，锚点来自真实上一句', () => {
  const f = fixture()
  try {
    raw(f, 'a', '今天把插件跑通了')
    f.advance(151 * 60000)
    const built = buildCandidates(gateInput(f))
    assert.equal(built.selected?.kind, 'small_talk')
    assert.match(String(built.selected.topic), /今天把插件跑通了/)
    assert.ok(built.selected.reasons.join('；').includes('151 分钟'))
  } finally { f.close() }
})

test('idle talk: 已删除的原文不能当锚点', () => {
  const f = fixture()
  try {
    raw(f, 'a', '今天把插件跑通了')
    f.db.run('UPDATE raw_messages SET deleted_at_ms = ?, content = ? WHERE id = ?', f.now(), '', 'a')
    f.advance(200 * 60000)
    assert.equal(buildCandidates(gateInput(f)).selected, null)
  } finally { f.close() }
})

test('idle talk: 同一空闲窗口只入队一次，下一窗口才再候选', async () => {
  const f = fixture()
  try {
    raw(f, 'a', '今天把插件跑通了')
    f.advance(151 * 60000)
    let calls = 0
    const scheduler = new ProactiveScheduler({
      config: f.config, repos: f.repos, metrics: f.metrics,
      listConversations: () => [{ conversationId: 'c', principalId: 'p' }],
      generate: async () => { calls += 1; return '还在忙吗？' },
      now: f.now,
    })
    assert.equal((await scheduler.scan(f.now())).enqueued, 1)
    assert.equal(calls, 1)
    const again = await scheduler.scan(f.now() + 60_000)
    assert.equal(again.enqueued, 0)
    assert.equal(again.skipped.at(-1).reason, 'awaiting-reply')
    // 发出去没回就暂停；回了之后要等冷却过去，下一个空闲窗口才会再开口。
    f.db.run("UPDATE outbox SET status = 'sent', sent_at_ms = ? WHERE status = 'pending'", f.now())
    f.advance(5 * 60000)
    raw(f, 'b', '刚回来，插件现在能用了')
    f.advance(181 * 60000)
    const third = await scheduler.scan(f.now())
    assert.equal(third.enqueued, 1)
    assert.equal(calls, 2)
    const pending = f.db.all("SELECT content FROM outbox WHERE status = 'pending'")
    assert.equal(pending.length, 1)
  } finally { f.close() }
})

test('idle talk: 静默时段仍然挡住', () => {
  const f = fixture()
  try {
    raw(f, 'a', '今天把插件跑通了')
    // 起点 02:00Z = 10:00 上海；推进到 15:10Z = 23:10 上海。
    f.advance(13 * 3600000 + 10 * 60000)
    assert.ok(checkGates(gateInput(f)).blocked.includes('quiet-hours'))
    assert.equal(buildCandidates(gateInput(f)).selected, null)
  } finally { f.close() }
})
