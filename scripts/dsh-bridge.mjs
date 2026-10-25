import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { DshBridgeClient } from './dsh-bridge-client.mjs'

const usage = `DSH Desktop direct bridge (no window automation)
  node scripts/dsh-bridge.mjs status
  node scripts/dsh-bridge.mjs list
  node scripts/dsh-bridge.mjs create --cwd <directory>
  node scripts/dsh-bridge.mjs send --session <id> --file <task.txt> [--request <uuid>]
  node scripts/dsh-bridge.mjs read --session <id> [--before <seq>]
  node scripts/dsh-bridge.mjs wait --session <id> --request <uuid> [--timeout <ms>] [--pages <1-100>]
  node scripts/dsh-bridge.mjs cancel --session <id>
  Optional: --connection <connection.json>; default ~/.dsh/codex-bridge/connection.json
  Send queues work; wait observes one exact request. Approval remains in DSH.`

function required(values, key) {
  if (!values[key]) throw new Error(`--${key} is required`)
  return values[key]
}

function integer(value, fallback, minimum = 0) {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error('Invalid integer option')
  return Number(value)
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    connection: { type: 'string' }, cwd: { type: 'string' }, session: { type: 'string' },
    file: { type: 'string' }, request: { type: 'string' }, before: { type: 'string' },
    timeout: { type: 'string' }, pages: { type: 'string' }, help: { type: 'boolean' }
  } })
  const command = positionals[0] ?? 'status'
  if (values.help) console.log(usage)
  else {
    if (!['status', 'list', 'create', 'send', 'read', 'wait', 'cancel'].includes(command)) throw new Error(usage)
    const client = await DshBridgeClient.discover(values.connection)
    let result
    switch (command) {
      case 'status': {
        const { items } = await client.list()
        result = { connected: true, transport: 'DSH authenticated loopback API', sessions: items.length }
        break
      }
      case 'list': result = await client.list(); break
      case 'create': result = await client.create(required(values, 'cwd')); break
      case 'send': {
        const sessionId = required(values, 'session')
        const text = await readFile(required(values, 'file'), 'utf8')
        // Emit correlation before admission: an ambiguous timeout can be retried safely.
        const requestId = values.request ?? randomUUID()
        console.error(JSON.stringify({ sessionId, requestId, state: 'sending' }))
        result = await client.send(sessionId, text, requestId)
        break
      }
      case 'read': result = await client.read(required(values, 'session'), 50, integer(values.before)); break
      case 'wait': result = await client.wait(required(values, 'session'), required(values, 'request'), { timeoutMs: integer(values.timeout, 60000), maxPages: integer(values.pages, 20, 1) }); break
      case 'cancel': result = await client.cancel(required(values, 'session')); break
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  // Never print exception causes, authenticated URLs, cookies, or server bodies.
  console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, '[local endpoint]'))
  process.exitCode = 1
}
