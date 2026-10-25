import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fixture } from '../helpers/fixture.mjs'
import { DesktopDelivery } from '../../lib/adapters/desktop-delivery.js'
import * as plugin from '../../lib/index.js'
const runtime = new URL('../../artifacts/desktop-v03-runtime/node_modules/@deepseek-ai/', import.meta.url)
const available = existsSync(new URL('dsh-session/lib/index.js', runtime))

test('A29 / A28: installed Desktop Session accepts assistant proactive messages with idempotency and inbound recheck', { skip: !available }, async () => {
  const { Session } = await import(new URL('dsh-session/lib/index.js', runtime))
  const f = fixture()
  try {
    const session = Session.create('desktop-proactive')
    const delivery = new DesktopDelivery(f.repos)
    delivery.register(session, f.binding, 'builtin')
    const sent = await delivery.send('c', '昨天的面试后来怎么样？', 'op-message', 0)
    assert.equal(sent.kind, 'accepted')
    assert.equal(session.deriveMessages().filter(m => m.role === 'assistant').length, 1)
    assert.equal((await delivery.send('c', '重复', 'op-message', 0)).kind, 'accepted')
    assert.equal(session.snapshotEvents().length, 1)
    f.repos.insertRawMessage({ id: 'new', conversationId: 'c', platformMessageKey: 'new', role: 'user', sourceKind: 'dsh', content: '先别发', occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null })
    assert.equal((await delivery.send('c', '旧稿', 'next', 0)).kind, 'rejected')
    assert.equal(session.snapshotEvents().length, 1)
  } finally { f.close() }
})

test('A16 / A18: installed LlmRuntime returns a directly iterable stream, guards local text and excludes background calls', { skip: !available }, async () => {
  const { Context } = await import(new URL('cordis/lib/index.js', runtime))
  const { LlmRuntime } = await import(new URL('dsh-llm/lib/index.js', runtime))
  const { Session } = await import(new URL('dsh-session/lib/index.js', runtime))
  const f = fixture(), ctx = new Context()
  let memory, llmFiber, terminal
  try {
    llmFiber = ctx.plugin(LlmRuntime)
    await llmFiber
    memory = ctx.plugin(plugin, { storage: { directory: f.directory, backupDaily: false }, proactive: { enabled: false }, expression: { repairMaxCallsPerTurn: 0 } })
    await memory
    terminal = ctx.on('llm/stream', () => (async function* () { yield { type: 'text-delta', index: 0, text: '当前心情：心情平稳' }; yield { type: 'usage', usage: { inputTokens: 10 } }; yield { type: 'finish', reason: { kind: 'stop' } } })())
    const session = Session.create('guard-target')
    await ctx.emit('agent/inbox/claimed', { agent: { id: 'main', session }, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } })
    const llm = ctx.get('llm')
    let visible = 0
    // The agent loop consumes stream() directly, without awaiting its result.
    const blocked = llm.stream({ provider: 'test', model: 'fake', messages: [], sessionId: session.id })
    assert.equal(typeof blocked[Symbol.asyncIterator], 'function', 'middleware must return an AsyncIterable, not a Promise')
    await assert.rejects(async () => { for await (const chunk of blocked) { if (chunk.type === 'text-delta') visible++ } }, /expression blocked/)
    assert.equal(visible, 0)
    const internal = []
    for await (const chunk of llm.stream({ provider: 'test', model: 'fake', messages: [] })) internal.push(chunk)
    assert.equal(internal.filter(x => x.type === 'usage').length, 1)
    assert.equal(internal[0].text, '当前心情：心情平稳')
    const untracked = []
    for await (const chunk of llm.stream({ provider: 'test', model: 'fake', messages: [], sessionId: 'untracked' })) untracked.push(chunk)
    assert.deepEqual(untracked, internal)
    terminal()
    const expected = [{ type: 'text-delta', index: 0, text: '你好呀' }, { type: 'usage', usage: { inputTokens: 10 } }, { type: 'finish', reason: { kind: 'stop' } }]
    terminal = ctx.on('llm/stream', () => (async function* () { yield* expected })())
    const accepted = []
    for await (const chunk of llm.stream({ provider: 'test', model: 'fake', messages: [], sessionId: session.id })) accepted.push(chunk)
    assert.deepEqual(accepted, expected)
    await memory.dispose(); memory = undefined
    const after = []
    for await (const chunk of llm.stream({ provider: 'test', model: 'fake', messages: [], sessionId: session.id })) after.push(chunk)
    assert.deepEqual(after, expected)
  } finally { terminal?.(); await memory?.dispose(); await llmFiber?.dispose(); f.close() }
})
