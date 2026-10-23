/**
 * SQLite 连接与能力探测（任务书 §5.1 / §5.2 / §3.3）。
 *
 * 驱动选择：宿主 Node 24 自带 `node:sqlite`（实测 SQLite 3.53.4），不需要
 * 编译 native 模块，也不会有 ABI 不匹配。使用同步驱动，因此：
 *   - 所有写操作走短事务 + 有序执行（repositories 层保证顺序）；
 *   - 事件循环影响由 scripts/benchmark.mjs 实测记录，不用 Promise.race 假装中断。
 *
 * 这个文件只负责「怎么连、连上有什么能力」，不含任何业务 SQL。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StorageConfig } from '../config.js'

export interface DatabaseOptions {
  file: string
  busyTimeoutMs: number
  /** true 时用 `:memory:`，仅供测试。 */
  memory?: boolean
}

export interface SqliteCapabilities {
  sqliteVersion: string
  fts5: boolean
  json1: boolean
  wal: boolean
  driver: 'node:sqlite'
  driverVersion: string
}

export interface SqlValue {
  readonly [key: string]: unknown
}

export type Row = Record<string, unknown>

/**
 * 薄封装：只暴露 exec/prepare/transaction，其他一律由 repositories 负责，
 * 避免上层随手拼 SQL。
 */
export class Database {
  readonly raw: DatabaseSync
  readonly file: string
  private closed = false
  private depth = 0

  constructor(options: DatabaseOptions) {
    this.file = options.memory === true ? ':memory:' : options.file
    if (options.memory !== true) {
      mkdirSync(dirname(this.file), { recursive: true })
    }
    this.raw = new DatabaseSync(this.file)
    // foreign_keys 必须在连接层开启，SQL 事务里写无效。
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(options.busyTimeoutMs))}`)
    if (options.memory !== true) {
      // WAL 让后台读不阻塞前台写；内存库不支持 WAL。
      this.raw.exec('PRAGMA journal_mode = WAL')
      this.raw.exec('PRAGMA synchronous = NORMAL')
    }
  }

  get isOpen(): boolean {
    return !this.closed
  }

  exec(sql: string): void {
    this.assertOpen()
    this.raw.exec(sql)
  }

  prepare(sql: string) {
    this.assertOpen()
    return this.raw.prepare(sql)
  }

  /** 单行查询，没有结果返回 undefined。 */
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    const statement = this.prepare(sql)
    const row = statement.get(...(params as never[]))
    return row as T | undefined
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    const statement = this.prepare(sql)
    return statement.all(...(params as never[])) as T[]
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const statement = this.prepare(sql)
    const result = statement.run(...(params as never[]))
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    }
  }

  /**
   * 同步事务。嵌套调用复用外层事务（savepoint 语义由外层 BEGIN 承担），
   * 抛错一律 ROLLBACK 并原样抛出——不允许「吞掉异常当作成功」。
   */
  transaction<T>(work: () => T): T {
    this.assertOpen()
    const outer = this.depth === 0
    const savepoint = `sp_${this.depth}`
    if (outer) this.raw.exec('BEGIN IMMEDIATE')
    else this.raw.exec(`SAVEPOINT ${savepoint}`)
    this.depth += 1
    try {
      const value = work()
      this.depth -= 1
      if (outer) this.raw.exec('COMMIT')
      else this.raw.exec(`RELEASE ${savepoint}`)
      return value
    } catch (error) {
      this.depth -= 1
      try {
        if (outer) this.raw.exec('ROLLBACK')
        else this.raw.exec(`ROLLBACK TO ${savepoint}`)
      } catch {
        // 回滚失败说明连接已不可用，交由上层降级并上报。
      }
      throw error
    }
  }

  capabilities(): SqliteCapabilities {
    const version = (this.get<{ v: string }>('SELECT sqlite_version() AS v')?.v ?? 'unknown') as string
    let fts5 = false
    try {
      this.raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)")
      this.raw.exec('DROP TABLE IF EXISTS __fts_probe')
      fts5 = true
    } catch {
      fts5 = false
    }
    let json1 = true
    try {
      const row = this.get<{ v: unknown }>("SELECT json_extract('{\"a\":1}', '$.a') AS v")
      json1 = Number(row?.v ?? 0) === 1
    } catch {
      json1 = false
    }
    let wal = false
    try {
      wal = String(this.get<{ v: string }>('PRAGMA journal_mode')?.v ?? '').toLowerCase() === 'wal'
    } catch {
      wal = false
    }
    return {
      sqliteVersion: version,
      fts5,
      json1,
      wal,
      driver: 'node:sqlite',
      driverVersion: process.versions['node'] ?? 'unknown',
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.raw.close()
    } catch {
      // 关闭失败不影响进程退出。
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('database 已关闭')
  }
}

/**
 * 打开伴生库。
 *
 * `companionId` 是**必填**的：早期版本把 `storage.directory` 直接当库文件打开，
 * 结果在目录已存在时得到 `unable to open database file`（SQLite 打不开目录），
 * 在目录不存在时更糟——它悄悄建了一个名叫目录名的文件。所以这里强制走
 * `databaseFile()` 拼出 `<directory>/<companionId>.sqlite3`。
 */
export function openDatabase(
  storage: StorageConfig,
  memory: boolean,
  companionId: string,
): Database {
  return new Database({
    file: memory ? ':memory:' : databaseFile(storage.directory, companionId),
    busyTimeoutMs: storage.busyTimeoutMs,
    memory,
  })
}

/** 数据库文件路径：<storage.directory>/<companionId>.sqlite3 */
export function databaseFile(storageDirectory: string, companionId: string): string {
  const safe = companionId.replace(/[^A-Za-z0-9._-]+/g, '_')
  return `${storageDirectory.replace(/[\\/]+$/, '')}/${safe}.sqlite3`
}

export function databaseExists(file: string): boolean {
  return existsSync(file)
}
