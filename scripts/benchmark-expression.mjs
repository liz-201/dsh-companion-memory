import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveConfig } from '../lib/config.js'
import { openDatabase } from '../lib/storage/database.js'
import { migrate } from '../lib/storage/migrations.js'
import { Repositories } from '../lib/storage/repositories.js'
import { PRESETS, initialSnapshot } from '../lib/domain/affect-reducer.js'
import { ExpressionRuntime } from '../lib/expression/runtime.js'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-expression-bench-'))
const config = resolveConfig({}), db = openDatabase({ ...config.storage, directory: dir }, true)
try {
  const now = Date.parse('2026-10-24T03:00:00Z')
  migrate(db, { now, fts5: true })
  const repos = new Repositories(db)
  repos.ensureCompanion(config.companion.id, 'bench', PRESETS.balanced, now)
  repos.ensurePrincipal('p', config.companion.id, 'owner', 'u', now)
  repos.ensureConversation('c', 'p', 'private', 'desktop', now)
  const runtime = new ExpressionRuntime(repos, config), state = initialSnapshot('p', 'balanced', 'v1', now)
  const timings = []
  for (let index = 0; index < 1000; index++) {
    repos.insertRawMessage({ id: `u-${index}`, conversationId: 'c', platformMessageKey: `u-${index}`, role: 'user', sourceKind: 'bench', content: `我在讨论第${index}个想法`, occurredAtMs: now + index, observedAtMs: now + index, deliveryStatus: null, deletedAtMs: null })
    const start = performance.now()
    await runtime.guard(`第${index}个想法可以再试试。`, state, '你怎么看', now + index)
    timings.push(performance.now() - start)
  }
  timings.sort((a, b) => a - b)
  const result = { mode: 'local-only-no-model', turns: 1000, p50Ms: timings[499], p95Ms: timings[949], p99Ms: timings[989], includes: ['contact exposure', 'personality/plan', 'habits/history', 'lint', 'audit write'], qualityVerified: false }
  fs.mkdirSync('artifacts', { recursive: true })
  fs.writeFileSync('artifacts/v03-expression-benchmark.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  db.close()
  const target = path.resolve(dir)
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('companion-expression-bench-')) throw new Error('Unsafe cleanup')
  fs.rmSync(target, { recursive: true, force: true })
}
