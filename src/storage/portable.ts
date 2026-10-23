import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, lstatSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../config.js'
import type { Database, Row } from './database.js'
import { Repositories } from './repositories.js'
import { backupNow, backupDirectory } from './backup.js'
import { rebuildAffect } from '../domain/affect-projector.js'
import { buildLexicalTerms } from '../memory/lexical-index.js'

const TABLES: Record<string, readonly string[]> = {
  companions: ['id'], principals: ['id'], conversations: ['id'], identity_links: ['namespace', 'external_key'], owner_channels: ['conversation_id'],
  raw_messages: ['id'], turns: ['id'], appraisals: ['id'], relationship_episodes: ['id'], affect_events: ['id'], affect_snapshots: ['principal_id'],
  memories: ['id'], memory_evidence: ['memory_id', 'message_id'], memory_edges: ['from_id', 'to_id', 'relation'], tasks: ['id'], outbox: ['id'],
  topic_checkpoints: ['id'], background_jobs: ['id'], deletion_tombstones: ['id'], audit_events: [], plugin_settings: ['key'],
}
const DERIVED = new Set(['affect_snapshots', 'relationship_episodes'])
const MAX_BYTES = 256 * 1024 * 1024
type Snapshot = Record<string, Row[]>
type Inventory = Record<string, Record<string, string>>
interface Checkpoint { id: string; inventory: Inventory }
export interface PortablePayload {
  format: 'dsh-companion-transfer'
  version: 1
  id: string
  createdAtMs: number
  companionId: string
  ownerId: string
  schema: { version: number; checksum: string }[]
  ancestors: Checkpoint[]
  tables: Snapshot
  plugin: Record<string, string>
}
export interface ImportReport { inserted: number; updated: number; deleted: number; conflicts: number; alreadyImported: boolean; backup: string | null; pausedTasks: number }

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson((value as Record<string, unknown>)[key])).join(',') + '}'
}
function hash(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex') }
function keyFor(table: string, row: Row): string {
  return stableJson(TABLES[table]!.length ? TABLES[table]!.map(key => row[key]) : [row['kind'], row['entity_id'], row['created_at_ms'], row['payload_json']])
}
function logicalRow(row: Row): Row { const { seq: _seq, ...copy } = row; return copy }
function inventory(tables: Snapshot): Inventory {
  return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, Object.fromEntries(rows.map(row => [keyFor(table, row), hash(row)]))]))
}
function transferableSetting(key: string): boolean { return !key.startsWith('local.') && !key.startsWith('portable.') && !key.startsWith('review:') && !key.startsWith('consolidation.cursor:') }
function takeSnapshot(db: Database): Snapshot {
  return Object.fromEntries(Object.keys(TABLES).map(table => [table, db.all(`SELECT * FROM ${table}`).map(logicalRow).filter(row => table !== 'plugin_settings' || transferableSetting(String(row['key'])))]))
}
function pluginFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('Portable plugin must not contain symbolic links')
    if (stat.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); return }
    files[relative(root, path).split(sep).join('/')] = readFileSync(path).toString('base64')
  }
  for (const entry of ['lib', 'migrations', 'prompts', 'integration', 'scripts', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) if (existsSync(join(root, entry))) visit(join(root, entry))
  return files
}

export function exportPortable(db: Database, config: Config, file: string, options: { includePlugin?: boolean; pluginRoot?: string; nowMs?: number } = {}): { file: string; id: string; messages: number; memories: number } {
  const repos = new Repositories(db)
  const ownerId = repos.getSetting('owner.id')
  if (!ownerId) throw new Error('Owner identity is missing; start the plugin once before exporting')
  const id = randomUUID()
  const nowMs = options.nowMs ?? Date.now()
  const payload = db.transaction((): PortablePayload => ({
    format: 'dsh-companion-transfer', version: 1, id, createdAtMs: nowMs, companionId: config.companion.id, ownerId,
    schema: db.all<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version'),
    ancestors: db.all<{ id: string; inventory_json: string }>('SELECT id, inventory_json FROM portable_checkpoints ORDER BY created_at_ms DESC, rowid DESC LIMIT 8').reverse().map(row => ({ id: row.id, inventory: JSON.parse(row.inventory_json) as Inventory })),
    tables: takeSnapshot(db), plugin: {},
  }))
  if (options.includePlugin !== false) payload.plugin = pluginFiles(options.pluginRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
  const bytes = Buffer.from(stableJson(payload))
  if (bytes.length > MAX_BYTES) throw new Error('Transfer package exceeds the 256 MiB uncompressed limit')
  const envelope = { format: 'dsh-companion-transfer', version: 1, sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') }
  const target = resolve(file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  db.run('INSERT INTO portable_checkpoints(id, inventory_json, created_at_ms) VALUES (?, ?, ?)', id, stableJson(inventory(payload.tables)), nowMs)
  return { file: target, id, messages: payload.tables['raw_messages']!.length, memories: payload.tables['memories']!.length }
}

export function readPortable(file: string): { payload: PortablePayload; checksum: string } {
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as { format?: string; version?: number; sha256?: string; data?: string }
  if (envelope.format !== 'dsh-companion-transfer' || envelope.version !== 1 || typeof envelope.data !== 'string' || envelope.data.length > MAX_BYTES * 2) throw new Error('Unsupported transfer package')
  const bytes = gunzipSync(Buffer.from(envelope.data, 'base64'), { maxOutputLength: MAX_BYTES })
  const checksum = createHash('sha256').update(bytes).digest('hex')
  if (checksum !== envelope.sha256) throw new Error('Transfer checksum mismatch; no data imported')
  const payload = JSON.parse(bytes.toString('utf8')) as PortablePayload
  if (payload.format !== 'dsh-companion-transfer' || payload.version !== 1 || typeof payload.id !== 'string' || typeof payload.ownerId !== 'string' || !payload.tables || !Array.isArray(payload.ancestors)) throw new Error('Invalid transfer payload')
  for (const table of Object.keys(payload.tables)) if (!Object.hasOwn(TABLES, table) || !Array.isArray(payload.tables[table])) throw new Error(`Unsupported transfer table: ${table}`)
  for (const table of Object.keys(TABLES)) if (!Array.isArray(payload.tables[table])) throw new Error(`Transfer table missing: ${table}`)
  return { payload, checksum }
}

/** Extract only package-owned files into a new directory. Never touches a DSH profile or credentials. */
export function unpackPlugin(payload: PortablePayload, directory: string): void {
  const target = resolve(directory)
  if (existsSync(target)) throw new Error('Plugin destination already exists; choose a new directory')
  const allowed = new Set(['lib', 'migrations', 'prompts', 'integration', 'scripts', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE'])
  const entries = Object.entries(payload.plugin)
  for (const [name, data] of entries) {
    const parts = name.split('/')
    if (!allowed.has(parts[0]!) || parts.some(part => !part || part === '.' || part === '..' || /[:\\\0]/.test(part)) || typeof data !== 'string') throw new Error('Unsafe plugin path in transfer')
    if (!resolve(target, ...parts).startsWith(target + sep)) throw new Error('Plugin extraction path escapes destination')
  }
  if (!payload.plugin['lib/index.js'] || !payload.plugin['package.json']) throw new Error('This transfer does not contain a plugin build')
  for (const [name, data] of entries) {
    const file = join(target, ...name.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' })
  }
}

function writeRow(db: Database, table: string, row: Row, existing?: Row): void {
  const columns = Object.keys(row)
  if (!existing || !TABLES[table]!.length) {
    db.run(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]))
  } else {
    const keys = TABLES[table]!
    const values = columns.filter(column => !keys.includes(column))
    if (values.length) db.run(`UPDATE ${table} SET ${values.map(column => `${column} = ?`).join(',')} WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`, ...values.map(column => row[column]), ...keys.map(key => row[key]))
  }
}

export function importPortable(db: Database, config: Config, payload: PortablePayload, checksum: string, options: { nowMs?: number; resumeReminders?: boolean } = {}): ImportReport {
  const nowMs = options.nowMs ?? Date.now()
  const repos = new Repositories(db)
  const report: ImportReport = { inserted: 0, updated: 0, deleted: 0, conflicts: 0, alreadyImported: false, backup: null, pausedTasks: 0 }
  const prior = db.get<{ checksum: string }>('SELECT checksum FROM portable_imports WHERE package_id = ?', payload.id)
  if (prior) { if (prior.checksum !== checksum) throw new Error('Transfer identity was reused with different content'); return { ...report, alreadyImported: true } }
  if (payload.companionId !== config.companion.id) throw new Error(`Companion differs; configure companion.id=${payload.companionId} before import`)
  for (const source of payload.schema) {
    const local = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = ?', source.version)
    if (!local || local.checksum !== source.checksum) throw new Error('Database schema differs; install the included plugin version before importing')
  }
  const populated = Number(db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM raw_messages) + (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM affect_events) AS n')?.n ?? 0) > 0
  if (populated && repos.getSetting('owner.id') !== payload.ownerId) throw new Error('Owner differs; refusing to combine two different owners')
  for (const [table, rows] of Object.entries(payload.tables)) {
    const columns = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).filter(column => column.name !== 'seq').map(column => column.name))
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.entries(row).some(([column, value]) => !columns.has(column) || value !== null && typeof value !== 'string' && typeof value !== 'number')) throw new Error(`Invalid transfer row in ${table}`)
      const key = keyFor(table, row)
      if (seen.has(key)) throw new Error(`Duplicate transfer identity in ${table}`)
      seen.add(key)
    }
  }
  let base: Inventory = {}
  for (const ancestor of payload.ancestors) {
    const known = db.get<{ inventory_json: string }>('SELECT inventory_json FROM portable_checkpoints WHERE id = ?', ancestor.id)
    if (known) {
      if (hash(JSON.parse(known.inventory_json)) !== hash(ancestor.inventory)) throw new Error('Transfer lineage mismatch')
      base = ancestor.inventory
    }
  }
  if (db.file !== ':memory:') report.backup = backupNow(db, { directory: backupDirectory(db.file), keepDays: 365, label: `${config.companion.id}-pre-import-${randomUUID()}` }, nowMs).file
  const conflicts = (table: string, key: string, local: Row | undefined, incoming: Row | undefined, baseHash?: string): void => {
    const id = hash([payload.id, table, key])
    db.run('INSERT OR IGNORE INTO portable_conflicts(id, package_id, table_name, row_key, local_json, incoming_json, base_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, payload.id, table, key, local ? stableJson(local) : null, incoming ? stableJson(incoming) : null, baseHash ?? null, nowMs)
    report.conflicts++
  }
  db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = ON')
    const local = takeSnapshot(db)
    const rebuild = new Set<string>()
    const deletes: { table: string; row: Row }[] = []
    db.run('UPDATE topic_checkpoints SET current_flag = 0')
    for (const [table, incomingRows] of Object.entries(payload.tables)) {
      const current = new Map(local[table]!.map(row => [keyFor(table, row), row]))
      const incoming = new Map(incomingRows.map(row => [keyFor(table, row), row]))
      for (const [key, raw] of incoming) {
        if (table === 'plugin_settings' && !transferableSetting(String(raw['key']))) continue
        const row = { ...raw }
        const existing = current.get(key)
        const baseHash = base[table]?.[key]
        const localHash = existing ? hash(existing) : undefined
        const incomingHash = hash(raw)
        if (incomingHash === localHash) continue
        if (existing && incomingHash === baseHash) continue
        if (!existing && baseHash && populated) continue // Locally deleted: do not resurrect.
        if (table === 'affect_events' && row['principal_id']) rebuild.add(String(row['principal_id']))
        if (existing && localHash !== baseHash) {
          if (DERIVED.has(table)) { rebuild.add(String(row['principal_id'])); continue }
          if (table === 'raw_messages' && (existing['deleted_at_ms'] !== null || row['deleted_at_ms'] !== null)) {
            row['deleted_at_ms'] = existing['deleted_at_ms'] ?? row['deleted_at_ms']
            if (row['deleted_at_ms'] !== null) row['content'] = ''
          } else if (['outbox', 'background_jobs', 'audit_events'].includes(table)) continue
          else { conflicts(table, key, existing, raw, baseHash); continue }
        }
        if (table === 'outbox' && ['pending', 'sending', 'failed'].includes(String(row['status']))) { row['status'] = 'cancelled'; row['last_error_code'] = 'portable-import-no-replay' }
        if (table === 'background_jobs' && ['pending', 'leased'].includes(String(row['status']))) row['status'] = 'cancelled'
        if (table === 'tasks' && row['status'] === 'confirmed' && !options.resumeReminders) { row['status'] = 'proposed'; report.pausedTasks++ }
        if (table === 'topic_checkpoints') row['current_flag'] = 0
        writeRow(db, table, row, existing)
        if (existing) report.updated++; else report.inserted++
      }
      for (const [key, row] of current) if (base[table]?.[key] && !incoming.has(key)) {
        if (hash(row) === base[table]![key]) deletes.push({ table, row })
        else if (!DERIVED.has(table)) conflicts(table, key, row, undefined, base[table]![key])
      }
    }
    for (const { table, row } of deletes.reverse()) {
      const keys = TABLES[table]!
      if (!keys.length || table === 'plugin_settings' && !transferableSetting(String(row['key']))) continue
      db.run(`DELETE FROM ${table} WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`, ...keys.map(key => row[key])); report.deleted++
    }
    repos.setSetting('owner.id', payload.ownerId, nowMs)
    if (!repos.getSetting('local.device-id')) repos.setSetting('local.device-id', randomUUID(), nowMs)
    // Tombstones override a stale copy's facts, including after a three-way branch merge.
    for (const tombstone of db.all<{ affected_ids_json: string }>('SELECT affected_ids_json FROM deletion_tombstones')) for (const id of JSON.parse(tombstone.affected_ids_json) as string[]) {
      db.run('DELETE FROM memory_evidence WHERE memory_id = ? OR message_id = ?', id, id)
      db.run('DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?', id, id)
      db.run('DELETE FROM memories WHERE id = ?', id)
      db.run('UPDATE raw_messages SET content = ?, deleted_at_ms = COALESCE(deleted_at_ms, ?) WHERE id = ?', '', nowMs, id)
    }
    // Keep the imported snapshot exactly for a fresh/fast-forward restore. Rebuild only divergent projections.
    if (populated) for (const principal of rebuild) {
      const stored = repos.getSnapshot(principal)
      const snapshot = rebuildAffect(repos, config, principal, nowMs)
      repos.putSnapshot(snapshot, stored?.revision ?? 0)
    }
    db.run('UPDATE topic_checkpoints SET current_flag = 1 WHERE id IN (SELECT id FROM topic_checkpoints t WHERE id = (SELECT id FROM topic_checkpoints x WHERE x.conversation_id = t.conversation_id ORDER BY created_at_ms DESC, id DESC LIMIT 1))')
    if (db.capabilities().fts5) {
      db.run('DELETE FROM memory_fts')
      for (const memory of db.all<{ id: string; principal_id: string; claim: string; status: string }>('SELECT id, principal_id, claim, status FROM memories')) if (memory.status === 'active') {
        const terms = buildLexicalTerms([memory.claim])
        db.run('INSERT INTO memory_fts(memory_id, principal_id, lexical_terms, aliases) VALUES (?, ?, ?, ?)', memory.id, memory.principal_id, terms, '')
      }
    }
    if (db.all('PRAGMA foreign_key_check').length) throw new Error('Transfer would break data references; import rolled back')
    for (const ancestor of payload.ancestors) db.run('INSERT OR IGNORE INTO portable_checkpoints(id, inventory_json, created_at_ms) VALUES (?, ?, ?)', ancestor.id, stableJson(ancestor.inventory), nowMs - 1)
    db.run('INSERT INTO portable_checkpoints(id, inventory_json, created_at_ms) VALUES (?, ?, ?)', payload.id, stableJson(inventory(payload.tables)), nowMs)
    db.run('INSERT INTO portable_imports VALUES (?, ?, ?)', payload.id, checksum, nowMs)
  })
  return report
}
