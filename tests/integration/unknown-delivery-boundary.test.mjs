import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'

function sent(f, id, plannedAtMs, receiptAtMs, kind = 'unknown') {
  f.repos.enqueueOutbox({ id, conversationId: 'c', turnId: null, candidateKey: id, taskId: null, content: id, contentHash: id, plannedAtMs, expectedInboundSeq: 0 })
  f.db.run("UPDATE outbox SET status='sending' WHERE id=?", id)
  f.repos.finishOutbox(id, { kind, atMs: receiptAtMs })
}

test('unknown grace uses actual sent time, including old plans and exact cutoff boundaries', () => {
  const f = fixture()
  try {
    const now = f.now(), cutoff = now - 24 * 3600_000
    sent(f, 'just-unknown', now - 3 * 86400_000, now)
    sent(f, 'before', now - 3 * 86400_000, cutoff - 1)
    sent(f, 'equal', now - 3 * 86400_000, cutoff)
    sent(f, 'after', now - 3 * 86400_000, cutoff + 1)
    sent(f, 'confirmed-old', now - 3 * 86400_000, cutoff - 1, 'accepted')
    assert.deepEqual(new Set(f.repos.unresolvedOutbox('c', 0, cutoff).map(row => row.id)), new Set(['just-unknown', 'equal', 'after', 'confirmed-old']))
    assert.deepEqual(new Set(f.repos.unresolvedOutbox('c', cutoff, cutoff).map(row => row.id)), new Set(['just-unknown', 'equal', 'after']))
    assert.equal(f.repos.outboxStatus('before'), 'unknown')
  } finally { f.close() }
})

test('bridge and deleted messages cannot acknowledge an unknown delivery; a live human can', () => {
  const f = fixture()
  try {
    sent(f, 'pending-ack', f.now() - 1000, f.now())
    f.advance(1)
    const put = (id, content, deletedAtMs = null) => f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh', content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs })
    put('bridge', '[Codex 协作回复 / mailbox ack-test] done')
    put('deleted', '收到', f.now())
    assert.equal(f.repos.unresolvedOutbox('c', 0, f.now() - 86400_000).length, 1)
    put('human', '收到这个分享了')
    assert.equal(f.repos.unresolvedOutbox('c', 0, f.now() - 86400_000).length, 0)
  } finally { f.close() }
})
