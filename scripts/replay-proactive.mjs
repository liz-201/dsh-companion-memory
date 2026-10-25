import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveConfig } from '../lib/config.js'
import { openDatabase } from '../lib/storage/database.js'
import { migrate } from '../lib/storage/migrations.js'
import { Repositories } from '../lib/storage/repositories.js'
import { Metrics } from '../lib/runtime/metrics.js'
import { PRESETS } from '../lib/domain/affect-reducer.js'
import { addOpportunity } from '../lib/proactive/opportunity.js'
import { ProactiveScheduler } from '../lib/proactive/scheduler.js'
import { OutboxWorker } from '../lib/proactive/outbox-worker.js'
import { inQuietHours } from '../lib/proactive/candidate-builder.js'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-proactive-replay-'))
const config = resolveConfig({ proactive: { timezone: 'UTC' } })
const db = openDatabase({ ...config.storage, directory: dir }, true)
try {
  let now = Date.parse('2026-10-01T00:00:00Z'), calls = 0, sent = 0, generated = 0, noCandidateCalls = 0
  migrate(db, { now, fts5: true })
  const repos = new Repositories(db), metrics = new Metrics()
  repos.ensureCompanion(config.companion.id, 'replay', PRESETS.balanced, now)
  repos.ensurePrincipal('p', config.companion.id, 'owner', 'u', now)
  repos.ensureConversation('c', 'p', 'private', 'desktop', now)
  const binding = { companionId: config.companion.id, botAccountId: 'owner', userId: 'u', conversationId: 'c', principalId: 'p', conversationKind: 'private', visibility: 'private' }
  const scheduler = new ProactiveScheduler({ config, repos, metrics, now: () => now, listConversations: () => [{ conversationId: 'c', principalId: 'p' }], generate: async () => { calls++; return '面试之后怎么样？' } })
  const worker = new OutboxWorker({ config, repos, metrics, now: () => now, chatForConversation: () => 'desktop:test', transport: { sendText: async () => {
    assert.equal(inQuietHours(now, 'UTC', config.proactive.quietStart, config.proactive.quietEnd), false)
    sent++
    return sent === 3 ? { kind: 'unknown', atMs: now, code: 'simulated-timeout' } : { kind: 'accepted', atMs: now, platformMessageId: `sent-${sent}` }
  } } })
  for (let tick = 0; tick < 1008; tick++) {
    const day = Math.floor(tick / 72)
    if (tick % 72 === 25) {
      repos.setSetting('proactive.enabled', day === 4 ? '0' : '1', now)
      const message = repos.insertRawMessage({ id: `day-${day}`, conversationId: 'c', platformMessageKey: `day-${day}`, role: 'user', sourceKind: 'replay', content: '我今天去面试', occurredAtMs: now, observedAtMs: now, deliveryStatus: null, deletedAtMs: null }).row
      addOpportunity(repos, { binding, kind: 'follow_up', summary: message.content, sourceIds: [message.id], nowMs: now, notBeforeMs: now + 3 * 3600000, expiresAtMs: now + 12 * 3600000 })
    }
    const before = calls
    const result = await scheduler.scan(now)
    generated += result.generated
    if (result.candidates === 0 && calls !== before) noCandidateCalls++
    await worker.runOnce(now)
    now += 20 * 60000
  }
  assert.equal(noCandidateCalls, 0)
  assert.equal(generated, calls)
  assert.ok(sent > 0)
  assert.ok(sent <= 28)
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'unknown'").n, 1)
  const result = { fake: true, qualityVerified: false, days: 14, scans: 1008, generated, sent, noCandidateCalls, quietHourViolations: 0, unknownNotRetried: true }
  fs.mkdirSync('artifacts', { recursive: true })
  fs.writeFileSync('artifacts/v03-proactive-replay.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  db.close()
  const target = path.resolve(dir)
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('companion-proactive-replay-')) throw new Error('Unsafe cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
}
