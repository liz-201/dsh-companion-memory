import { createInterface } from 'node:readline'
const mode = process.argv[2]
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
let stopped = false
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-fixture' } } })
  if (message.method === 'turn/interrupt') {
    stopped = true
    send({ id: message.id, result: {} })
    notify('turn/completed', { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'interrupted' } })
  }
  if (message.method !== 'turn/start') continue
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
  if (mode !== 'early' && mode !== 'hang') setTimeout(completion, 10)
}
