import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveConfig } from '../lib/config.js'
import { openDatabase } from '../lib/storage/database.js'
import { migrate } from '../lib/storage/migrations.js'
import { Repositories } from '../lib/storage/repositories.js'
import { OwnerIdentity } from '../lib/domain/owner-identity.js'
import { prunePortableCheckpoints } from '../lib/storage/portable.js'
import { StartupSync } from '../lib/storage/startup-sync.js'

const directory = mkdtempSync(join(tmpdir(), 'companion-retention-bench-'))
const config = resolveConfig({ storage: { directory, backupDaily: false } })
const db = openDatabase(config.storage, false, config.companion.id)
function size() {
  return { checkpoints: db.get('SELECT COUNT(*) AS n FROM portable_checkpoints').n,
    inventoryBytes: db.get('SELECT COALESCE(SUM(length(CAST(inventory_json AS BLOB))),0) AS n FROM portable_checkpoints').n,
    pages: db.get('PRAGMA page_count').page_count, freePages: db.get('PRAGMA freelist_count').freelist_count,
    fileBytes: statSync(db.file).size }
}
try {
  migrate(db, { now: Date.now(), fts5: true })
  const repos = new Repositories(db)
  new OwnerIdentity(repos, config)
  db.transaction(() => {
    for (let i = 0; i < 362; i++) {
      const rows = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`id-${i}-${index}`, String(index).padStart(64, 'a')]))
      db.run('INSERT INTO portable_checkpoints VALUES (?, ?, ?)', `legacy-${i}`, JSON.stringify({ raw_messages: rows }), i)
    }
  })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const before = size(), started = performance.now()
  const pruned = prunePortableCheckpoints(db)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const afterPrune = size(), pruneMs = performance.now() - started
  // Only this disposable benchmark database is vacuumed. No live user data.
  db.exec('VACUUM')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const afterOfflineVacuum = size()
  const sync = new StartupSync(db, config)
  sync.publish('bench')
  const idleStart = performance.now()
  for (let i = 0; i < 1000; i++) sync.publish('bench')
  const report = { environment: 'temporary synthetic database; no live database accessed', before, pruned, afterPrune, afterOfflineVacuum,
    pruneMs, idlePublish1000Ms: performance.now() - idleStart, syncIntervalSeconds: config.storage.syncIntervalSeconds }
  writeFileSync(new URL('../artifacts/portable-retention-report.json', import.meta.url), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  db.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1).startsWith('companion-retention-bench-')) throw new Error('Unsafe benchmark cleanup')
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
