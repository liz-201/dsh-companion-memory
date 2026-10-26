import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export const defaultConnectionFile = () => join(homedir(), '.dsh', 'codex-bridge', 'connection.json')

export function localConnectionUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !url.port || !url.searchParams.get('token')) {
    throw new Error('Bridge connection must be a token-authenticated http://127.0.0.1:port URL')
  }
  return url
}

/** Correlate only durable evidence for this request, including pre-step errors. */
export function taskOutcome(events, requestId) {
  const inbox = { 'next-turn': [], 'next-step': [] }
  const stepped = new Set()
  const ours = message => message?.source?.rpcId === requestId
  let open, targetTurn, observed = false, surfaced = false
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'turn/start') open = data.turn
    if (event.type === 'step/start') stepped.add(data.turn)
    if (event.type === 'user/message' && ours(data)) {
      observed = true; surfaced = true; targetTurn = open
    }
    if (event.type === 'agent/inbox/spliced' && Object.hasOwn(inbox, data.target)) {
      const queue = inbox[data.target], start = data.start, count = data.removedCount ?? 0
      if (!Number.isSafeInteger(start) || start < 0 || start > 100000 || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(data.inserted)) continue
      // A bounded page may begin with unknown queued entries before ours.
      while (queue.length < start) queue.push(null)
      const removed = queue.splice(start, count, ...data.inserted)
      if (data.inserted.some(ours)) observed = true
      if (removed.some(ours) && !data.inserted.some(ours)) {
        if (data.outcome === 'canceled') return { state: 'stopped', observed: true, reason: 'cancelled-before-run', end: event }
        targetTurn = open
      }
    }
    if (event.type === 'turn/end') {
      if (targetTurn !== undefined && data.turn === targetTurn) {
        const executed = surfaced || stepped.has(targetTurn)
        return { state: executed && data.reason?.kind === 'completed' ? 'completed' : 'stopped', observed: true,
          ...(!executed && data.reason?.kind === 'completed' ? { reason: 'claimed-without-execution' } : {}), end: event }
      }
      open = undefined
    }
  }
  const queued = Object.values(inbox).some(queue => queue.some(ours))
  return { state: 'pending', observed, needsEarlier: observed && targetTurn === undefined && !queued,
    reason: queued ? 'queued' : observed ? 'running-or-awaiting-approval' : 'request-not-observed' }
}

export class DshBridgeClient {
  constructor(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.url = localConnectionUrl(url)
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  static async discover(file = defaultConnectionFile()) {
    let descriptor
    try { descriptor = JSON.parse(await readFile(file, 'utf8')) } catch {
      throw new Error('DSH bridge is not ready. Install dsh-codex-bridge and reload/restart DSH Desktop.')
    }
    if (descriptor.version !== 1) throw new Error('Unsupported DSH bridge descriptor version')
    return new DshBridgeClient(descriptor.url)
  }

  async connect() {
    const endpoint = new URL('/connect', this.url)
    endpoint.searchParams.set('token', this.url.searchParams.get('token'))
    endpoint.searchParams.set('interactions', 'none')
    const response = await this.fetch(endpoint, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) })
    if (response.status !== 302) throw new Error(`DSH authentication failed (${response.status}); reload/restart DSH to refresh the bridge`)
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error('DSH did not issue an operator credential')
    this.cookie = cookie
    return this
  }

  async rpc(method, request) {
    if (!this.cookie) await this.connect()
    const rpcId = randomUUID()
    const response = await this.fetch(new URL(`/api/${method}`, this.url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request === undefined ? {} : { [method === 'session/list' ? '_request' : 'request']: request } } })
    })
    if (!response.ok) throw new Error(`DSH ${method} failed (${response.status}); a send timeout has an unknown outcome; reuse its requestId`)
    let envelope
    try { envelope = await response.json() } catch { throw new Error('Invalid DSH RPC JSON response') }
    if (!envelope || typeof envelope !== 'object' || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') {
      throw new Error('Invalid or mismatched DSH RPC response')
    }
    if (!envelope.result.ok) {
      const error = new Error(`DSH ${method}: ${envelope.result.error?.code ?? 'unknown error'}`)
      error.code = envelope.result.error?.code
      throw error
    }
    return envelope.result.value
  }

  list() { return this.rpc('session/list', {}) }
  create(cwd) { return this.rpc('session/create', { cwd }) }
  cancel(sessionId) { return this.rpc('session/cancel', { sessionId }) }
  async send(sessionId, text, requestId = randomUUID(), { mode = 'queue' } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Task text must not be empty')
    if (!['queue', 'steer'].includes(mode)) throw new Error('Unsupported DSH delivery mode')
    await this.rpc('session/prompt', { sessionId, requestId, mode, content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' })
    return { sessionId, requestId, accepted: true }
  }

  async read(sessionId, maxMessages = 50, beforeSeq) {
    const snapshot = await this.rpc('session/projections', { sessionId })
    if (snapshot?.kind !== 'sequenced') throw new Error('Session is missing or requires migration inside DSH')
    return this.readPage(sessionId, snapshot.asOfSeq, maxMessages, beforeSeq)
  }

  async readPage(sessionId, throughSeq, maxMessages, beforeSeq) {
    const page = await this.rpc('session/page', {
      address: { kind: 'session', sessionId }, throughSeq, maxMessages,
      ...(beforeSeq === undefined ? {} : { beforeSeq })
    })
    return { sessionId, asOfSeq: throughSeq, ...page }
  }

  async wait(sessionId, requestId, { timeoutMs = 60000, intervalMs = 2000, maxPages = 20 } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('maxPages must be an integer from 1 to 100')
    const until = Date.now() + timeoutMs
    do {
      let page = await this.read(sessionId, 200), records = page.records, pages = 1
      const throughSeq = page.asOfSeq
      let outcome
      while (true) {
        const events = records.filter(row => row.type === 'event').map(row => row.event)
        outcome = taskOutcome(events, requestId)
        if (outcome.state !== 'pending') return { state: outcome.state, sessionId, requestId, end: outcome.end, reason: outcome.reason, asOfSeq: throughSeq, pages, records }
        if (outcome.observed && !outcome.needsEarlier || !page.hasMore || pages >= maxPages) break
        const firstSeq = events[0]?.seq
        if (!Number.isSafeInteger(firstSeq) || firstSeq <= 0) throw new Error('DSH history pagination did not advance')
        page = await this.readPage(sessionId, throughSeq, 200, firstSeq)
        const earlier = page.records.filter(row => row.type === 'event').map(row => row.event)
        if (!earlier.length || earlier.some(event => !Number.isSafeInteger(event.seq) || event.seq >= firstSeq)) throw new Error('DSH history pagination did not advance')
        records = [...page.records, ...records]
        pages++
      }
      if (Date.now() >= until) return { state: 'pending', sessionId, requestId, pages, asOfSeq: throughSeq,
        reason: page.hasMore && (!outcome.observed || outcome.needsEarlier) ? 'history-window-exhausted' : outcome.reason }
      await delay(Math.min(intervalMs, Math.max(0, until - Date.now())))
    } while (true)
  }
}
