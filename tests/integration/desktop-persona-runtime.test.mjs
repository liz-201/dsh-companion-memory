import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fixture } from '../helpers/fixture.mjs'
import * as plugin from '../../lib/index.js'
import { DatabaseSync } from 'node:sqlite'

const runtime = new URL('../../artifacts/desktop-cwd-runtime/node_modules/@deepseek-ai/', import.meta.url)
const available = existsSync(new URL('dsh-system-prompt/lib/index.js', runtime))

test('real Desktop local messages consolidate into searchable facts with observer turns and no generated replies', { skip: !available }, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  const { Context } = await import(new URL('cordis/lib/index.js', runtime))
  const f = fixture(), ctx = new Context(), calls = []
  let memory, reader
  try {
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'scripted' }) })
    ctx.provide('llm', { async *stream(request) {
      const system = request.messages[0].content[0].text
      if (system.includes('独立的后台观察器')) { yield { type: 'text-delta', text: '<evt>{"v":1,"e":[]}</evt>' }; return }
      const transcript = request.messages[1].content[0].text
      calls.push(transcript)
      const source = transcript.match(/\[([^\]]+)\] seq=\d+ user:/)[1]
      yield { type: 'text-delta', text: JSON.stringify({ changes: [{ kind: 'fact', subject: 'owner', predicate: 'city', object: '杭州', claim: '用户住在杭州', sourceMessageIds: [source], quote: '我住在杭州, 喜欢"冰美式"', confidence: 0.9, salience: 0.8, eventAtMs: null }] }) }
    } })
    memory = ctx.plugin(plugin, { storage: { directory: f.directory, backupDaily: false }, proactive: { enabled: false }, background: { consolidateEveryTurns: 2 } })
    await memory
    const service = ctx.get('companionMemory'), session = { id: 'local-consolidation' }
    for (let i = 0; i < 2; i++) await ctx.emit('session/event', session, {
      type: 'user/message', surfaceOp: 'append', seq: i + 1, time: Date.now(),
      data: { id: `m${i}`, source: { kind: 'user' }, content: [{ type: 'text', text: '我住在杭州，喜欢“冰美式”' }] },
    })
    for (let i = 0; i < 150 && service.status().counts.memories === 0; i++) {
      t.mock.timers.tick(6000)
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(service.status().counts.turns, 2)
    assert.equal(service.status().counts.memories, 1, JSON.stringify(service.status().background))
    assert.equal(calls.length, 1)
    reader = new DatabaseSync(service.status().database, { readOnly: true })
    assert.equal(reader.prepare("SELECT status FROM background_jobs WHERE kind = 'consolidate'").get().status, 'done')
    assert.equal(reader.prepare("SELECT claim FROM memories WHERE predicate_key = 'city'").get().claim, '用户住在杭州')
    assert.ok(Number(reader.prepare("SELECT value FROM plugin_settings WHERE key LIKE 'consolidation.cursor:%'").get().value) > 0)
  } finally { reader?.close(); await memory?.dispose(); t.mock.timers.reset(); f.close() }
})

test('real Desktop loader: complete persona and suppressed contexts retain required memory through refresh and unload cleanly', { skip: !available }, async () => {
  const { Context } = await import(new URL('cordis/lib/index.js', runtime))
  const { SystemPrompt, renderPrompt, renderContextSnapshot } = await import(new URL('dsh-system-prompt/lib/index.js', runtime))
  const f = fixture(), ctx = new Context()
  let memory, prompts, commandProvider, complete, suppress
  try {
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'scripted' }) })
    ctx.provide('llm', { async *stream() { yield { type: 'text-delta', text: '<evt>{"v":1,"e":[],"m":[{"k":"preference","t":"喜欢蓝色，示例变量 {{cwd}}","q":"喜欢蓝色，示例变量 {{cwd}}"}]}</evt>' } } })
    // Mount the actual entry before optional host services arrive.
    memory = ctx.plugin(plugin, { storage: { directory: f.directory, backupDaily: false }, proactive: { enabled: false }, integration: { excludedAgentIds: ['internal'] } })
    await memory
    assert.equal(memory.state, 2)
    const service = ctx.get('companionMemory')
    assert.ok(service)
    const commands = []
    commandProvider = ctx.plugin({ name: 'test-commands', apply(child) { child.provide('commands', { register(command) { commands.push(command); return () => commands.splice(commands.indexOf(command), 1) } }) } })
    await commandProvider
    prompts = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await prompts
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(commands.length, 1, 'optional commands must attach after the host service arrives')
    const prompt = ctx.get('systemPrompt')
    const session = { id: 'desktop', header: { agentPreset: 'whale' } }
    const agent = { id: 'main', ctx, session }
    const invoke = rawInput => commands[0].handler({ agent, rawInput })
    const persona = '你是鲸鱼娘。完整人设中的 {{model}} 是纯文本。'
    complete = prompt.section({ name: 'test:complete', order: 1, complete: true, interpolate: false, text: persona })
    suppress = prompt.suppressRuntimeContext()
    const context = { agent, scope: agent }
    const message = { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: '喜欢蓝色，示例变量 {{cwd}}' }] }
    await ctx.emit('agent/inbox/claimed', { agent, message })
    await prompt.assemble(context)
    await ctx.emit('session/event', session, { type: 'user/message', surfaceOp: 'append', seq: 1, time: Date.now(), data: message })
    const deadline = Date.now() + 8000
    while (service.status().counts.memories === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(service.status().counts.memories, 1, JSON.stringify(service.status().background))
    const assembly = await prompt.assemble(context)
    assert.equal(renderPrompt(assembly), persona, 'complete persona is untouched')
    assert.deepEqual(assembly.sections.map(s => s.name), ['test:complete'])
    assert.match(renderContextSnapshot(assembly), /喜欢蓝色/)
    assert.match(renderContextSnapshot(assembly), /\{\{cwd\}\}/, 'memory is literal, never interpolated')
    assert.match(renderContextSnapshot(assembly), /当前电脑/)
    assert.match(renderContextSnapshot(assembly), /表达参考/)
    assert.doesNotMatch(renderContextSnapshot(assembly), /当前心情：|和对方：/)
    assert.match(renderContextSnapshot(prompt.refreshContext(assembly, context)), /喜欢蓝色/)
    const hidden = await prompt.assemble({ agent: { id: 'internal', session: { id: 'excluded' } } })
    assert.equal(renderContextSnapshot(hidden), '')
    const other = await prompt.assemble({ agent: { id: 'other', session: { id: 'other', header: { agentPreset: 'fish' } } } })
    assert.match(renderContextSnapshot(other), /喜欢蓝色/, 'every host persona receives the same owner memory')
    assert.match(invoke('status').text, /preset:whale/, 'host persona remains visible while memory is shared')
    await service.shutdown()
    await memory.dispose(); memory = undefined
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(commands.length, 0)
    assert.equal(renderContextSnapshot(await prompt.assemble(context)), '')
  } finally {
    await memory?.dispose()
    suppress?.(); complete?.()
    await prompts?.dispose()
    await commandProvider?.dispose()
    f.close()
  }
})
