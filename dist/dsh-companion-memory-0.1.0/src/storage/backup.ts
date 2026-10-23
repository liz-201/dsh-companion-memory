/**
 * 备份（任务书 §21.2）。
 *
 * 用 `VACUUM INTO` 生成一致性快照：它在事务里读，不会拿到半写状态，也不需要
 * 停写。文件名带本地日期，保留 N 天；超过保留期的自动清理。
 *
 * 注意：备份是「恢复用」不是「删除用」。恢复旧备份后必须先重放
 * deletion_tombstones（deletion.ts 的 replayTombstones），否则会复活已删除数据。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Database } from './database.js'

export interface BackupOptions {
  directory: string
  keepDays: number
  /** 文件名前缀，一般是 companionId。 */
  label: string
}

export interface BackupRecord {
  file: string
  bytes: number
  createdAtMs: number
}

const STAMP_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.sqlite3$/

export function backupDirectory(dbFile: string): string {
  return join(dirname(dbFile), 'backups')
}

/**
 * 生成一次备份。同一天重复调用会覆盖当天文件（当天的备份是最新的更好）。
 */
export function backupNow(db: Database, options: BackupOptions, nowMs: number): BackupRecord {
  mkdirSync(options.directory, { recursive: true })
  const date = localDate(nowMs)
  const file = join(options.directory, `${options.label}-${date}.sqlite3`)
  if (existsSync(file)) rmSync(file, { force: true })
  // VACUUM INTO 要求目标文件不存在。
  db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  return { file, bytes: statSync(file).size, createdAtMs: nowMs }
}

export function listBackups(directory: string): BackupRecord[] {
  if (!existsSync(directory)) return []
  const out: BackupRecord[] = []
  for (const name of readdirSync(directory)) {
    const match = STAMP_RE.exec(name)
    if (match === null) continue
    const full = join(directory, name)
    const stat = statSync(full)
    out.push({ file: full, bytes: stat.size, createdAtMs: stat.mtimeMs })
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs)
}

/** 删除超过 keepDays 的备份，返回被删除的文件。当天永远保留。 */
export function pruneBackups(directory: string, keepDays: number, nowMs: number): string[] {
  const cutoff = nowMs - Math.max(1, keepDays) * 86_400_000
  const removed: string[] = []
  const today = localDate(nowMs)
  for (const record of listBackups(directory)) {
    if (record.file.endsWith(`-${today}.sqlite3`)) continue
    if (record.createdAtMs >= cutoff) continue
    rmSync(record.file, { force: true })
    removed.push(basename(record.file))
  }
  return removed
}

export interface BackupSummary {
  latest?: BackupRecord | undefined
  total: number
  bytes: number
  directory: string
}

export function backupSummary(directory: string): BackupSummary {
  const records = listBackups(directory)
  return {
    latest: records[0],
    total: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    directory,
  }
}

function localDate(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
