import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const defaultMailboxFile = () => join(homedir(), '.dsh', 'codex-bridge', 'mailbox.sqlite3')
const MAX_TEXT_BYTES = 64 * 1024
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
      if (version !== 0 && version !== 1) throw Error('Unsupported mailbox schema')
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
        PRAGMA user_version=1;
      `)
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

  enqueue({ id = randomUUID(), sessionId, text }, nowMs = Date.now()) {
    identity(id, 'message id'); identity(sessionId, 'session id'); textValue(text); clock(nowMs)
    if (!sessionId.startsWith('session-')) throw Error('A DSH session id is required for replies')
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
      if (previous) {
        if (previous.session_id !== sessionId || previous.body !== text) throw Error('Message id already belongs to different content')
      } else this.db.prepare('INSERT INTO messages(id,session_id,body,created_at_ms,delivery_request_id) VALUES(?,?,?,?,?)')
        .run(id, sessionId, text, nowMs, randomUUID())
      return { ...this.read(id, nowMs), receiver: this.receiver(nowMs), wakesCodex: false }
    })
  }

  read(id, nowMs = Date.now()) {
    identity(id, 'message id'); clock(nowMs)
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
    if (!row) return null
    return {
      id: row.id, sessionId: row.session_id, text: row.body, createdAtMs: row.created_at_ms,
      state: row.delivered_at_ms !== null ? 'response-queued'
        : row.response !== null ? 'response-ready'
          : row.lease_until_ms > nowMs ? 'claimed' : 'pending',
      consumer: row.consumer, leaseUntilMs: row.lease_until_ms,
      response: row.response, respondedAtMs: row.responded_at_ms, deliveredAtMs: row.delivered_at_ms,
    }
  }

  claim(consumer, { nowMs = Date.now(), leaseMs = 90000, limit = 5 } = {}) {
    identity(consumer, 'consumer'); clock(nowMs); duration(leaseMs)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw Error('Limit must be 1..20')
    this.heartbeat(consumer, nowMs, leaseMs)
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM messages WHERE response IS NULL
        AND (consumer IS NULL OR lease_until_ms<=? OR consumer=?) ORDER BY created_at_ms,id LIMIT ?`)
        .all(nowMs, consumer, limit)
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

  async deliver(client, { id, now = Date.now } = {}) {
    if (id !== undefined) identity(id, 'message id')
    const rows = this.db.prepare(`SELECT * FROM messages WHERE response IS NOT NULL AND delivered_at_ms IS NULL
      ${id === undefined ? '' : 'AND id=?'} ORDER BY responded_at_ms,id LIMIT 20`).all(...(id === undefined ? [] : [id]))
    const delivered = []
    for (const row of rows) {
      // Stable DSH request identity closes the crash window between admission and local acknowledgement.
      await client.send(row.session_id, `[Codex 协作回复 / mailbox ${row.id}]\n${row.response}`, row.delivery_request_id, { mode: 'steer' })
      this.db.prepare('UPDATE messages SET delivered_at_ms=? WHERE id=? AND delivered_at_ms IS NULL').run(clock(now()), row.id)
      delivered.push({ id: row.id, state: 'response-queued' })
    }
    return delivered
  }

  status(nowMs = Date.now()) {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(response IS NULL),0) AS pending,
      COALESCE(SUM(response IS NOT NULL AND delivered_at_ms IS NULL),0) AS repliesAwaitingDelivery
      FROM messages`).get()
    return { ...counts, receiver: this.receiver(nowMs), wakesCodex: false }
  }
}
