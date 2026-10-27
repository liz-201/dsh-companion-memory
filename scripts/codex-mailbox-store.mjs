import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const defaultMailboxFile = () => join(homedir(), '.dsh', 'codex-bridge', 'mailbox.sqlite3')
const MAX_TEXT_BYTES = 64 * 1024
const messageKind = value => {
  if (!['chat', 'review', 'write'].includes(value)) throw Error('Kind must be chat, review or write')
  return value
}
const identity = (value, label) => {
  if (typeof value !== 'string' || !/^[\w.-]{1,160}$/.test(value)) throw Error(`Invalid ${label}`)
  return value
}
const textValue = value => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw Error('Message must contain 1..65536 UTF-8 bytes')
  return value
}
const clock = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid clock')
  return value
}
const duration = value => {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 300000) throw Error('Lease must be 1000..300000 ms')
  return value
}

/** Local durable messages. A heartbeat means a consumer polled, never that a model was woken. */
export class CodexMailbox {
  constructor(file = defaultMailboxFile()) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    try {
      chmodSync(file, 0o600)
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON')
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (![0, 1, 2].includes(version)) throw Error('Unsupported mailbox schema')
      this.db.exec('BEGIN IMMEDIATE')
      try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL, consumer TEXT, lease_until_ms INTEGER,
          response TEXT, responded_at_ms INTEGER, delivery_request_id TEXT NOT NULL UNIQUE,
          delivered_at_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS messages_pending ON messages(responded_at_ms, created_at_ms);
        CREATE TABLE IF NOT EXISTS receiver (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), consumer TEXT NOT NULL,
          last_seen_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
        );
      `)
      const columns = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(column => column.name))
      if (!columns.has('kind')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'write'")
      }
      for (const [column, definition] of [
        ['delivery_attempts', 'INTEGER NOT NULL DEFAULT 0'],
        ['delivery_last_attempt_at_ms', 'INTEGER'],
        ['delivery_retry_after_ms', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!columns.has(column)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`)
      }
      this.db.exec('PRAGMA user_version=2; COMMIT')
      this.deliveryInFlight = new Set()
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) { this.db.close(); throw error }
  }

  close() { this.db.close() }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  receiver(nowMs = Date.now()) {
    clock(nowMs)
    const row = this.db.prepare('SELECT * FROM receiver WHERE singleton=1').get()
    return row && row.expires_at_ms > nowMs
      ? { state: 'polling', consumer: row.consumer, lastSeenAtMs: row.last_seen_ms, expiresAtMs: row.expires_at_ms }
      : { state: 'offline', lastSeenAtMs: row?.last_seen_ms ?? null }
  }

  heartbeat(consumer, nowMs = Date.now(), leaseMs = 90000) {
    identity(consumer, 'consumer'); clock(nowMs); duration(leaseMs)
    return this.transaction(() => {
      const active = this.receiver(nowMs)
      if (active.state === 'polling' && active.consumer !== consumer) throw Error('Another mailbox consumer is active')
      this.db.prepare(`INSERT INTO receiver VALUES (1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
        consumer=excluded.consumer,last_seen_ms=excluded.last_seen_ms,expires_at_ms=excluded.expires_at_ms`)
        .run(consumer, nowMs, nowMs + leaseMs)
      this.db.prepare(`UPDATE messages SET lease_until_ms=? WHERE consumer=? AND response IS NULL AND lease_until_ms>?`)
        .run(nowMs + leaseMs, consumer, nowMs)
      return this.receiver(nowMs)
    })
  }

  offline(consumer) {
    identity(consumer, 'consumer')
    this.transaction(() => {
      this.db.prepare('DELETE FROM receiver WHERE singleton=1 AND consumer=?').run(consumer)
      this.db.prepare('UPDATE messages SET consumer=NULL,lease_until_ms=NULL WHERE consumer=? AND response IS NULL').run(consumer)
    })
  }

  enqueue({ id = randomUUID(), sessionId, text, kind = 'write' }, nowMs = Date.now()) {
    identity(id, 'message id'); identity(sessionId, 'session id'); textValue(text); clock(nowMs)
    messageKind(kind)
    if (!sessionId.startsWith('session-')) throw Error('A DSH session id is required for replies')
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
      if (previous) {
        if (previous.session_id !== sessionId || previous.body !== text || previous.kind !== kind) throw Error('Message id already belongs to different content')
      } else this.db.prepare('INSERT INTO messages(id,session_id,body,created_at_ms,delivery_request_id,kind) VALUES(?,?,?,?,?,?)')
        .run(id, sessionId, text, nowMs, randomUUID(), kind)
      return { ...this.read(id, nowMs), receiver: this.receiver(nowMs), wakesCodex: false }
    })
  }

  read(id, nowMs = Date.now()) {
    identity(id, 'message id'); clock(nowMs)
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
    if (!row) return null
    return {
      id: row.id, sessionId: row.session_id, text: row.body, kind: row.kind, createdAtMs: row.created_at_ms,
      state: row.delivered_at_ms !== null ? 'response-queued'
        : row.response !== null ? 'response-ready'
          : row.lease_until_ms > nowMs ? 'claimed' : 'pending',
      consumer: row.consumer, leaseUntilMs: row.lease_until_ms,
      response: row.response, respondedAtMs: row.responded_at_ms, deliveredAtMs: row.delivered_at_ms,
    }
  }

  claim(consumer, { nowMs = Date.now(), leaseMs = 90000, limit = 5, excludeIds = [], kinds = ['chat', 'review', 'write'] } = {}) {
    identity(consumer, 'consumer'); clock(nowMs); duration(leaseMs)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw Error('Limit must be 1..20')
    if (!Array.isArray(excludeIds) || excludeIds.length > 30) throw Error('Invalid active message ids')
    excludeIds.forEach(id => identity(id, 'message id'))
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > 3) throw Error('Invalid task kinds')
    kinds.forEach(messageKind)
    this.heartbeat(consumer, nowMs, leaseMs)
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM messages WHERE response IS NULL
        AND (consumer IS NULL OR lease_until_ms<=? OR consumer=?)
        AND kind IN (${kinds.map(() => '?').join(',')})
        ${excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : ''}
        ORDER BY created_at_ms,id LIMIT ?`)
        .all(nowMs, consumer, ...kinds, ...excludeIds, limit)
      const update = this.db.prepare('UPDATE messages SET consumer=?,lease_until_ms=? WHERE id=?')
      for (const { id } of rows) update.run(consumer, nowMs + leaseMs, id)
      return rows.map(({ id }) => this.read(id, nowMs))
    })
  }

  respond(id, consumer, text, nowMs = Date.now()) {
    identity(id, 'message id'); identity(consumer, 'consumer'); textValue(text); clock(nowMs)
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
      if (!row) throw Error('Unknown message')
      if (row.response !== null) {
        if (row.response !== text || row.consumer !== consumer) throw Error('A different reply is already recorded')
        return this.read(id, nowMs)
      }
      if (row.consumer !== consumer || row.lease_until_ms <= nowMs) throw Error('Claim this message with a live lease before replying')
      this.db.prepare('UPDATE messages SET response=?,responded_at_ms=? WHERE id=?').run(text, nowMs, id)
      return this.read(id, nowMs)
    })
  }

  async deliver(client, { id, now = Date.now, continueOnError = false } = {}) {
    if (id !== undefined) identity(id, 'message id')
    const rows = this.db.prepare(`SELECT * FROM messages WHERE response IS NOT NULL AND delivered_at_ms IS NULL
      ${id === undefined ? '' : 'AND id=?'} ${continueOnError ? 'AND delivery_retry_after_ms<=?' : ''}
      ORDER BY responded_at_ms,id LIMIT 20`)
      .all(...(id === undefined ? [] : [id]), ...(continueOnError ? [clock(now())] : []))
      .filter(row => !this.deliveryInFlight.has(row.id))
    rows.forEach(row => this.deliveryInFlight.add(row.id))
    const delivered = new Array(rows.length)
    const failedSessions = new Set()
    const retryDelayMs = 30000
    const send = async (row, index) => {
      if (failedSessions.has(row.session_id)) return
      const attemptedAtMs = clock(now())
      this.db.prepare(`UPDATE messages SET delivery_attempts=delivery_attempts+1,
        delivery_last_attempt_at_ms=?,delivery_retry_after_ms=? WHERE id=?`)
        .run(attemptedAtMs, attemptedAtMs + retryDelayMs, row.id)
      // Stable DSH request identity closes the crash window between admission and local acknowledgement.
      try {
        await client.send(row.session_id, `[Codex 协作回复 / mailbox ${row.id}]\n${row.response}`, row.delivery_request_id, { mode: 'steer' })
      } catch (error) {
        // Persist only attempt timing, never server errors or possibly secret response bodies.
        this.db.prepare(`UPDATE messages SET delivery_retry_after_ms=?
          WHERE session_id=? AND response IS NOT NULL AND delivered_at_ms IS NULL`)
          .run(clock(now()) + retryDelayMs, row.session_id)
        failedSessions.add(row.session_id)
        if (!continueOnError) throw error
        return
      }
      this.db.prepare('UPDATE messages SET delivered_at_ms=?,delivery_retry_after_ms=0 WHERE id=? AND delivered_at_ms IS NULL')
        .run(clock(now()), row.id)
      delivered[index] = { id: row.id, state: 'response-queued' }
    }
    try {
      if (!continueOnError) {
        // Explicit CLI retries remain immediate and report the first transport failure.
        for (let index = 0; index < rows.length; index++) await send(rows[index], index)
      } else {
        let next = 0
        const worker = async () => {
          while (next < rows.length) {
            const index = next++
            await send(rows[index], index)
          }
        }
        const workers = await Promise.allSettled(Array.from({ length: Math.min(4, rows.length) }, worker))
        const failed = workers.find(result => result.status === 'rejected')
        if (failed) throw failed.reason
      }
    } finally {
      rows.forEach(row => this.deliveryInFlight.delete(row.id))
    }
    return delivered.filter(Boolean)
  }

  status(nowMs = Date.now()) {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(response IS NULL),0) AS pending,
      COALESCE(SUM(response IS NOT NULL AND delivered_at_ms IS NULL),0) AS repliesAwaitingDelivery
      FROM messages`).get()
    return { ...counts, receiver: this.receiver(nowMs), wakesCodex: false }
  }
}
