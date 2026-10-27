import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

/** Only official stdio JSON-RPC. Never reads or exports local login credentials. */
export class CodexAppServerClient extends EventEmitter {
  constructor(command = 'codex', args = ['app-server', '--listen', 'stdio://'], { env = process.env } = {}) {
    super()
    this.pending = new Map()
    this.nextId = 1
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    this.child.stderr.on('data', () => {}) // Host logs may contain tool inputs or private account information.
    this.child.stdin.on('error', () => {})
    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.id !== undefined && message.method) {
        // No interactive permission or user-input substitution by the bridge.
        this.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable in the mailbox worker' } })
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        pending.cleanup?.()
        if (message.error) pending.reject(Error(`CODEX_RPC_${Number(message.error.code) || 'FAILED'}`))
        else pending.resolve(message.result)
      } else if (message.method) this.emit('notification', message)
    })
    const stopped = () => {
      for (const { reject, timer, cleanup } of this.pending.values()) { clearTimeout(timer); cleanup?.(); reject(Error('CODEX_PROCESS_EXITED')) }
      this.pending.clear()
      this.emit('stopped')
    }
    this.child.once('error', stopped)
    this.child.once('exit', stopped)
  }

  write(message) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  rpc(method, params, timeoutMs = 15000, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(Error('CODEX_RPC_ABORTED')); return }
      const id = this.nextId++
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const abort = () => { clearTimeout(timer); cleanup(); this.pending.delete(id); reject(Error('CODEX_RPC_ABORTED')) }
      const timer = setTimeout(() => { cleanup(); this.pending.delete(id); reject(Error('CODEX_RPC_TIMEOUT')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      this.write({ id, method, params })
    })
  }

  async initialize({ signal } = {}) {
    await this.rpc('initialize', { clientInfo: { name: 'dsh_codex_mailbox', title: 'DSH Codex local collaboration', version: '0.3.0' } }, 15000, { signal })
    this.write({ method: 'initialized', params: {} })
  }

  async startThread(cwd, developerInstructions, { readOnly = false, signal } = {}) {
    const result = await this.rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: readOnly ? 'read-only' : 'workspace-write',
      developerInstructions, config: { 'sandbox_workspace_write.network_access': true, 'sandbox_workspace_write.writable_roots': [] } }, 60000, { signal })
    if (!result?.thread?.id) throw Error('CODEX_THREAD_MISSING')
    return result.thread.id
  }

  async run(threadId, text, { timeoutMs = 600000, hardTimeoutMs = 1800000, signal, onStarted = () => {}, onProgress = () => {} } = {}) {
    if (signal?.aborted) throw Object.assign(Error('CODEX_TURN_INTERRUPTED'), { terminal: true, threadId })
    let turnId, timer, hardTimer, stopTimer, completed, finish, fail, timedOut = false, lastProgress = ''
    const admissionController = new AbortController()
    const early = []
    const messages = new Map()
    const result = new Promise((resolve, reject) => { finish = resolve; fail = reject })
    const failure = (code, terminal = false, status) => Object.assign(Error(code), { terminal, status, threadId, turnId, lastProgress })
    const armIdleTimeout = () => {
      if (completed || timedOut) return
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; interrupt() }, timeoutMs)
    }
    // Attach the listener before admission: fast completion can precede the RPC response.
    const consume = message => {
      const p = message.params ?? {}
      if (p.threadId !== threadId) return
      if (!turnId) { early.push(message); return }
      if (p.turnId && p.turnId !== turnId || p.turn?.id && p.turn.id !== turnId) return
      if (message.method.startsWith('item/')) {
        armIdleTimeout()
        if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase === 'commentary') lastProgress = String(p.item.text ?? '').slice(-1200)
        onProgress({ turnId, type: message.method })
      }
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && (!p.item.phase || p.item.phase === 'final_answer')) messages.set(p.item.id, p.item.text ?? '')
      if (message.method === 'turn/completed') {
        completed = true
        const status = p.turn?.status
        const reply = [...messages.values()].filter(x => x.trim()).at(-1)
        if (timedOut) fail(failure('CODEX_TURN_TIMEOUT', true, status))
        else if (status !== 'completed') fail(failure(`CODEX_TURN_${String(status ?? 'UNKNOWN').toUpperCase()}`, true, status))
        else if (!reply) fail(failure('CODEX_EMPTY_RESPONSE', true, status))
        else finish({ turnId, text: reply })
      }
    }
    const exited = () => fail(failure('CODEX_PROCESS_EXITED'))
    const interrupt = () => {
      if (completed) return
      if (!turnId) admissionController.abort()
      if (turnId) void this.rpc('turn/interrupt', { threadId, turnId }).catch(() => {})
      clearTimeout(stopTimer)
      stopTimer = setTimeout(() => fail(failure(timedOut ? 'CODEX_TURN_TIMEOUT' : 'CODEX_TURN_INTERRUPTED')), 5000)
    }
    this.on('notification', consume)
    this.on('stopped', exited)
    signal?.addEventListener('abort', interrupt, { once: true })
    // The rejection handler is attached now, including when the child exits during admission.
    result.catch(() => {})
    try {
      if (signal?.aborted) throw failure('CODEX_TURN_INTERRUPTED', true)
      // The absolute budget includes admission; a lost acknowledgement must not hold shutdown for a minute.
      hardTimer = setTimeout(() => { timedOut = true; interrupt() }, hardTimeoutMs)
      // Admission has its own transport deadline; inactivity starts after a known turn id.
      let admitted
      try { admitted = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }, 60000, { signal: admissionController.signal }) }
      catch (error) { throw failure(timedOut ? 'CODEX_TURN_TIMEOUT' : error.message) }
      turnId = admitted?.turn?.id
      if (!turnId) throw Error('CODEX_TURN_MISSING')
      await onStarted(turnId)
      for (const message of early) consume(message)
      if (signal?.aborted) interrupt()
      armIdleTimeout()
      return await result
    } finally {
      clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(stopTimer)
      signal?.removeEventListener('abort', interrupt)
      this.off('notification', consume)
      this.off('stopped', exited)
    }
  }

  close() { this.reader.close(); this.child.kill() }
}
