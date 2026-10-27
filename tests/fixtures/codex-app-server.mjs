import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
const mode = process.argv[2]
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
let stopped = false
let progressTimer
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method === 'initialize' && mode !== 'initialize-hang') send({ id: message.id, result: { userAgent: 'fake' } })
  if (message.method === 'thread/start' && mode !== 'thread-hang') {
    if (mode === 'review-isolation') {
      let discovered = false
      try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: message.params.cwd, encoding: 'utf8', stdio: 'pipe' }); discovered = true } catch {}
      if (discovered || message.params.sandbox !== 'workspace-write') {
        send({ id: message.id, error: { code: -32602, message: 'snapshot Git isolation failed' } })
        continue
      }
    }
    if (mode === 'read-only' && (message.params.sandbox !== 'read-only' || message.params.config['sandbox_workspace_write.writable_roots'].length !== 0)) {
      send({ id: message.id, error: { code: -32602, message: 'incorrect read-only sandbox' } })
    } else send({ id: message.id, result: { thread: { id: 'thread-fixture' } } })
  }
  if (message.method === 'turn/interrupt') {
    stopped = true
    clearInterval(progressTimer)
    send({ id: message.id, result: {} })
    notify('turn/completed', { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'interrupted' } })
  }
  if (message.method !== 'turn/start') continue
  if (mode === 'admission-hang') continue
  if (mode === 'exit') process.exit(3)
  if (mode === 'rpc-error') { send({ id: message.id, error: { code: -32602, message: 'private-secret-never-echo' } }); continue }
  const completion = () => {
    if (stopped) return
    notify('item/completed', { threadId: 'thread-fixture', turnId: 'wrong-turn', item: { id: 'wrong', type: 'agentMessage', text: 'wrong reply' } })
    notify('item/completed', { threadId: 'another-thread', turnId: 'turn-fixture', item: { id: 'other', type: 'agentMessage', text: 'another reply' } })
    notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'I will inspect' } })
    if (mode !== 'empty') notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'final', type: 'agentMessage', text: '鲸鱼确认：双向处理成功。' } })
    notify('turn/completed', { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: mode === 'fail' ? 'failed' : 'completed' } })
  }
  if (mode === 'early') completion()
  send({ id: message.id, result: { turn: { id: 'turn-fixture', status: 'inProgress' } } })
  if (mode === 'progress' || mode === 'progress-forever') {
    progressTimer = setInterval(() => notify('item/commandExecution/outputDelta', { threadId: 'thread-fixture', turnId: 'turn-fixture', delta: 'still working' }), 25)
    if (mode === 'progress') setTimeout(() => { clearInterval(progressTimer); completion() }, 170)
  } else if (mode !== 'early' && mode !== 'hang') setTimeout(completion, 10)
}
