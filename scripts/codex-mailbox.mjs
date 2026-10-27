import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexMailbox } from './codex-mailbox-store.mjs'
import { DshBridgeClient } from './dsh-bridge-client.mjs'

const usage = `DSH → Codex durable local mailbox (no API key, no extra listener)
  node scripts/codex-mailbox.mjs status
  node scripts/codex-mailbox.mjs send --session <DSH session-id> --file <UTF-8 text or -> [--id <stable-id>] [--kind chat|review|write]
  node scripts/codex-mailbox.mjs read --id <message-id>
  node scripts/codex-mailbox.mjs receive --consumer <name> [--wait-ms <0..45000>]
  node scripts/codex-mailbox.mjs heartbeat --consumer <name>
  node scripts/codex-mailbox.mjs reply --id <message-id> --consumer <name> --file <UTF-8 text or ->
  node scripts/codex-mailbox.mjs deliver [--id <message-id>]
  node scripts/codex-mailbox.mjs offline --consumer <name>
  Optional: --mailbox <sqlite3 file>, --connection <DSH connection.json>
  Send is durable admission, not proof of reading or model execution.
  An offline Codex session is NOT woken; pending messages survive until a consumer polls.`

function required(values, key) {
  if (!values[key]) throw Error(`--${key} is required`)
  return values[key]
}

async function input(file) {
  if (file !== '-') return readFile(file, 'utf8')
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 65536) throw Error('Message exceeds 65536 bytes')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

let mailbox
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    mailbox: { type: 'string' }, connection: { type: 'string' }, session: { type: 'string' },
    file: { type: 'string' }, id: { type: 'string' }, consumer: { type: 'string' }, kind: { type: 'string' },
    'wait-ms': { type: 'string' }, help: { type: 'boolean' }
  } })
  const command = positionals[0] ?? 'status'
  if (values.help) console.log(usage)
  else {
    if (!['status', 'send', 'read', 'receive', 'heartbeat', 'reply', 'deliver', 'offline'].includes(command)) throw Error(usage)
    mailbox = new CodexMailbox(values.mailbox)
    let result
    switch (command) {
      case 'status': result = mailbox.status(); break
      case 'send': result = mailbox.enqueue({ id: values.id, sessionId: required(values, 'session'), text: await input(required(values, 'file')), kind: values.kind ?? 'write' }); break
      case 'read': result = mailbox.read(required(values, 'id')); break
      case 'heartbeat': result = mailbox.heartbeat(required(values, 'consumer')); break
      case 'receive': {
        const consumer = required(values, 'consumer')
        const wait = values['wait-ms'] ?? '0'
        if (!/^\d+$/.test(wait) || Number(wait) > 45000) throw Error('--wait-ms must be 0..45000')
        const until = Date.now() + Number(wait)
        do {
          const messages = mailbox.claim(consumer)
          if (messages.length || Date.now() >= until) { result = { messages, receiver: mailbox.receiver() }; break }
          await delay(Math.min(1000, Math.max(0, until - Date.now())))
        } while (true)
        break
      }
      case 'reply': {
        const id = required(values, 'id')
        const reply = mailbox.respond(id, required(values, 'consumer'), await input(required(values, 'file')))
        try { await mailbox.deliver(await DshBridgeClient.discover(values.connection), { id }); result = mailbox.read(id) }
        catch { result = { ...reply, delivery: 'pending-retry', hint: 'Reply saved locally. Retry deliver when DSH is available.' }; process.exitCode = 2 }
        break
      }
      case 'deliver': result = await mailbox.deliver(await DshBridgeClient.discover(values.connection), { id: values.id }); break
      case 'offline': mailbox.offline(required(values, 'consumer')); result = mailbox.status(); break
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, '[local endpoint]'))
  process.exitCode = 1
} finally { mailbox?.close() }
