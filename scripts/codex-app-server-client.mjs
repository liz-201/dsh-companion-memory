import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

/** Only official stdio JSON-RPC. Never reads or exports local login credentials. */
export class CodexAppServerClient extends EventEmitter {
  constructor(command = 'codex', args = ['app-server', '--listen', 'stdio://']) {
    super()
    this.pending = new Map()
    this.nextId = 1
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
        if (message.error) pending.reject(Error(`CODEX_RPC_${Number(message.error.code) || 'FAILED'}`))
        else pending.resolve(message.result)
      } else if (message.method) this.emit('notification', message)
    })
    const stopped = () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(Error('CODEX_PROCESS_EXITED')) }
      this.pending.clear()
      this.emit('stopped')
    }
    this.child.once('error', stopped)
    this.child.once('exit', stopped)
  }

  write(message) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  rpc(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CODEX_RPC_TIMEOUT')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  async initialize() {
    await this.rpc('initialize', { clientInfo: { name: 'dsh_codex_mailbox', title: 'DSH Codex local collaboration', version: '0.2.0' } })
    this.write({ method: 'initialized', params: {} })
  }

  async startThread(cwd, developerInstructions) {
    const result = await this.rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write',
      developerInstructions, config: { 'sandbox_workspace_write.network_access': true } }, 60000)
    if (!result?.thread?.id) throw Error('CODEX_THREAD_MISSING')
    return result.thread.id
  }

  async run(threadId, text, { timeoutMs = 600000, signal, onStarted = () => {} } = {}) {
    let turnId, timer, stopTimer, completed, finish, fail, timedOut = false
    const early = []
    const messages = new Map()
    const result = new Promise((resolve, reject) => { finish = resolve; fail = reject })
    // Attach the listener before admission: fast completion can precede the RPC response.
    const consume = message => {
      const p = message.params ?? {}
      if (p.threadId !== threadId) return
      if (!turnId) { early.push(message); return }
      if (p.turnId && p.turnId !== turnId || p.turn?.id && p.turn.id !== turnId) return
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && (!p.item.phase || p.item.phase === 'final_answer')) messages.set(p.item.id, p.item.text ?? '')
      if (message.method === 'turn/completed') {
        completed = true
        const status = p.turn?.status
        const reply = [...messages.values()].filter(x => x.trim()).at(-1)
        if (timedOut) fail(Error('CODEX_TURN_TIMEOUT'))
        else if (status !== 'completed') fail(Error(`CODEX_TURN_${String(status ?? 'UNKNOWN').toUpperCase()}`))
        else if (!reply) fail(Error('CODEX_EMPTY_RESPONSE'))
        else finish({ turnId, text: reply })
      }
    }
    const exited = () => fail(Error('CODEX_PROCESS_EXITED'))
    const interrupt = () => {
      if (completed) return
      if (turnId) void this.rpc('turn/interrupt', { threadId, turnId }).catch(() => {})
      clearTimeout(stopTimer)
      stopTimer = setTimeout(() => fail(Error(timedOut ? 'CODEX_TURN_TIMEOUT' : 'CODEX_TURN_INTERRUPTED')), 5000)
    }
    this.on('notification', consume)
    this.on('stopped', exited)
    signal?.addEventListener('abort', interrupt, { once: true })
    // The rejection handler is attached now, including when the child exits during admission.
    result.catch(() => {})
    try {
      if (signal?.aborted) throw Error('CODEX_TURN_INTERRUPTED')
      const admitted = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }, Math.min(timeoutMs, 60000))
      turnId = admitted?.turn?.id
      if (!turnId) throw Error('CODEX_TURN_MISSING')
      onStarted(turnId)
      for (const message of early) consume(message)
      if (signal?.aborted) interrupt()
      timer = setTimeout(() => { timedOut = true; interrupt() }, timeoutMs)
      return await result
    } finally {
      clearTimeout(timer); clearTimeout(stopTimer)
      signal?.removeEventListener('abort', interrupt)
      this.off('notification', consume)
      this.off('stopped', exited)
    }
  }

  close() { this.reader.close(); this.child.kill() }
}
