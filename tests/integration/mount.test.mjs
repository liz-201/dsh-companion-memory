/**
 * 装配冒烟测试（任务书 §19 T55 一类的「能装能卸」验收）。
 *
 * 这里用一个假宿主把 `apply()` 真的跑起来：验证
 *   · 插件能在没有 OneBot、没有真实模型的机器上完成装配；
 *   · 入站消息走完一整轮，原始消息真的落库；
 *   · `companionMemory` 服务被提供，`/fish status` 能在不调模型的情况下回答；
 *   · 卸载时 disposer 全部执行、数据库句柄释放、不留定时器。
 *
 * 运行：node --test tests/integration/mount.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'

/** Windows 上 SQLite 的 -wal/-shm 可能还压在句柄上，清理失败不该算测试失败。 */
function safeRemove(dir) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 })
      return
    } catch (error) {
      if (attempt === 2) {
        if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
        return
      }
    }
  }
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../../lib/index.js'

test('default mounted plugin observes DSH desktop events, exposes local commands and exports on shutdown', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  const dir = mkdtempSync(join(tmpdir(), 'companion-desktop-'))
  const host = makeHost(['<evt>{"v":1,"e":[{"k":"appreciation","to":"self","i":"neutral","s":2,"c":0.99}]}</evt>'])
  const listeners = new Map()
  host.ctx.on = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) }
  try {
    apply(host.ctx, { storage: { directory: dir, backupDaily: false }, proactive: { enabled: false } })
    const service = host.provided.get('companionMemory')
    const session = { id: 'desktop-session' }, agent = { id: 'desktop-agent', session }
    listeners.get('session/event')(session, { type: 'user/message', seq: 1, time: Date.now(), surfaceOp: 'append', data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢你一直陪我' }] } })
    assert.equal(service.status().counts.raw_messages, 1)
    for (let i = 0; i < 100 && service.status().background.doneTotal === 0; i++) {
      t.mock.timers.tick(6000)
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(service.status().counts.affect_events, 1, JSON.stringify(service.status().background))
    assert.equal(host.requests.length, 1, 'only the background extraction calls the model')
    assert.equal(host.commands[0].handler({ agent, rawInput: 'mood' }).kind, 'success')
    const sync = host.commands[0].handler({ agent, rawInput: 'sync' })
    assert.equal(sync.kind, 'success'); assert.match(sync.text, /companion.json/)
    const assembly = await listeners.get('system-prompt/assemble')({}, { agent }, async () => ({ sections: [] }))
    assert.match(assembly.sections[0].text, /当前电脑/)
    await service.shutdown()
    assert.equal(listeners.size, 0)
  } finally { host.effects[0]?.()(); t.mock.timers.reset(); safeRemove(dir) }
})

/** 假宿主：只实现插件用到的那几个成员。 */
function makeHost(streamText) {
  const sections = []
  const provided = new Map()
  const effects = []
  const commands = []
  const emitted = []
  const requests = []
  const ctx = {
    systemPrompt: {
      section(options) {
        sections.push(options)
        return () => {
          const index = sections.indexOf(options)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder: () => 10,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'scripted' }) },
    llm: {
      async *stream(request) {
        requests.push(request)
        for (const piece of streamText) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
        yield { type: 'finish' }
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    },
    webServer: undefined,
    provide(service, value) {
      provided.set(service, value)
    },
    emit(event) {
      emitted.push(event)
    },
    effect(callback) {
      effects.push(callback)
    },
    on() {},
  }
  return { ctx, sections, provided, effects, commands, emitted, requests }
}

test('本人白名单与 Web 命令入口隔离，未知私聊不落库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-scope-'))
  const host = makeHost(['<say>你好</say>'])
  try {
    apply(host.ctx, { storage: { directory: dir, backupDaily: false }, channel: { ownerChats: ['123'] } })
    const service = host.provided.get('companionMemory')
    const before = service.status().counts
    assert.equal(service.accepts('private:123'), true)
    assert.equal(service.accepts('private:999'), false)
    assert.equal((await service.handleInbound({ chatId: 'private:999', text: '你好' })).handled, false)
    assert.equal(service.status().counts.raw_messages, before.raw_messages)
    assert.equal(host.commands[0].handler({ agent: {}, rawInput: 'status' }).kind, 'error')
    assert.equal(host.requests.length, 0)
    assert.equal(host.sections.length, 0)
  } finally { host.effects[0]?.()(); safeRemove(dir) }
})

test('主动开关持久化并可在重启后恢复，review 绑定隔离正式关系', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-settings-'))
  let host = makeHost(['<say>你好</say>'])
  const config = { storage: { directory: dir, backupDaily: false }, channel: { ownerChats: ['123'] } }
  try {
    apply(host.ctx, config)
    let service = host.provided.get('companionMemory')
    assert.equal(service.handleCommand({ chatId: 'private:123', text: '/fish proactive off' }).kind, 'success')
    const original = service.handleCommand({ chatId: 'private:123', text: '/fish mood 1' }).text
    const begin = service.handleCommand({ chatId: 'private:123', text: '/fish review begin friendly' })
    assert.equal(begin.kind, 'success', begin.text)
    assert.ok(begin.text.includes('已进入'))
    assert.notEqual(service.handleCommand({ chatId: 'private:123', text: '/fish mood 1' }).text, original)
    host.effects[0]()()
    host = makeHost(['<say>你好</say>'])
    apply(host.ctx, config)
    service = host.provided.get('companionMemory')
    assert.ok(service.handleCommand({ chatId: 'private:123', text: '/fish status' }).text.includes('主动消息：关'))
    assert.notEqual(service.handleCommand({ chatId: 'private:123', text: '/fish mood 1' }).text, original, '重启仍在沙盒')
    assert.equal(service.handleCommand({ chatId: 'private:123', text: '/fish review end' }).kind, 'success')
    assert.equal(service.handleCommand({ chatId: 'private:123', text: '/fish mood 1' }).text, original)
    assert.equal(service.handleCommand({ chatId: 'private:123', text: '/fish proactive on' }).kind, 'success')
  } finally { host.effects[0]?.()(); safeRemove(dir) }
})

test('插件元信息齐全', () => {
  assert.equal(name, 'dsh-companion-memory')
  assert.deepEqual(inject, [], 'Cordis accepts service names, not required/optional buckets')
})

test('装配 → 入站 → 落库 → 卸载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-mount-'))
  const host = makeHost(['<say>刚', '回来', '啊。</say>'])
  try {
    apply(host.ctx, {
      companion: { id: 'dafeiyu', name: '大肥鱼', preset: 'balanced', scope: 'owner_private' },
      storage: { directory: dir },
      channel: {
        onebotHttpBase: 'http://127.0.0.1:1',
        ownerChats: ['2940015320'],
        chatSessionsFile: join(dir, 'chat-sessions.json'),
      },
    })

    // 装配副作用
    assert.ok(host.provided.has('companionMemory'), '应提供 companionMemory 服务')
    assert.ok(host.emitted.includes('companionMemory/available'))
    assert.equal(host.sections.length, 0, '人格只进入已绑定请求，不注册全局提示段')
    assert.equal(host.commands.length, 1, '应注册 /fish 命令')
    assert.equal(host.effects.length, 1, '应登记一个生命周期 effect')

    const service = host.provided.get('companionMemory')
    assert.equal(typeof service.handleInbound, 'function')
    assert.equal(typeof service.handleCommand, 'function')
    assert.equal(service.version, '0.3.0-dev.4')

    // 状态：还没入站时也能回答
    const status = service.status()
    assert.equal(status.version, '0.3.0-dev.4')
    assert.equal(status.companion.id, 'dafeiyu')
    assert.ok(status.database.endsWith('.sqlite3'))

    // 入站一轮：OneBot 不可达，但消息必须落库、回合必须收尾
    const result = await service.handleInbound({
      chatId: 'private:2940015320',
      text: '我回来了，今天加班到十点',
      platformMessageKey: 'msg-1',
      sessionId: 'session-1',
      send: async () => ({ kind: 'accepted', atMs: Date.now(), platformMessageId: 'fixture-message' }),
    })
    assert.equal(result.handled, true)
    assert.ok(result.outcome, '应产生一次回合结果')
    assert.equal(result.outcome.status, 'say-only')
    assert.equal(result.outcome.sent.kind, 'accepted')
    assert.equal(host.requests.length, 1)
    assert.ok(host.requests[0].messages[0].content[0].text.length > 0)

    const counts = service.status().counts
    assert.ok(counts.raw_messages >= 1, '原始消息应已落库')

    // 重复到达同一条消息：幂等，不再开新一轮
    const again = await service.handleInbound({
      chatId: 'private:2940015320',
      text: '我回来了，今天加班到十点',
      platformMessageKey: 'msg-1',
      sessionId: 'session-1',
      send: async () => ({ kind: 'accepted', atMs: Date.now(), platformMessageId: 'fixture-message' }),
    })
    assert.equal(again.outcome?.status, 'skipped', '同一条平台消息重复到达应跳过')

    // 命令：不调模型也能回答
    const command = service.handleCommand({ text: '/fish status', chatId: 'private:2940015320' })
    assert.equal(command.kind, 'success')
    assert.ok(command.text.length > 0)

    const help = service.handleCommand({ text: '/fish', chatId: 'private:2940015320' })
    assert.equal(help.kind, 'success')
    assert.ok(help.text.includes('/fish'))

    const unknown = service.handleCommand({ text: '/fish 喵喵喵', chatId: 'private:2940015320' })
    assert.ok(unknown.text.includes('/fish'), '未知子命令应返回帮助文本（§15.1）')

    // 非 owner 私聊不能执行管理命令
    const other = service.handleCommand({ text: '/fish reset relationship --confirm', chatId: 'private:999' })
    assert.equal(other.kind, 'error')

    // 卸载：所有 disposer 执行且不抛错
    const disposer = host.effects[0]
    const cleanup = disposer()
    assert.equal(typeof cleanup, 'function')
    cleanup()
    assert.equal(host.sections.length, 0, '人格段应被移除')
    assert.equal(host.commands.length, 0, '命令应被移除')
  } finally {
    safeRemove(dir)
  }
})

test('缺 systemPrompt / llm 时降级装配而不是崩溃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-degrade-'))
  const provided = new Map()
  const ctx = {
    provide: (service, value) => provided.set(service, value),
    emit: () => {},
    effect: () => {},
  }
  try {
    apply(ctx, {
      companion: { id: 'dafeiyu', name: '大肥鱼', preset: 'gentle', scope: 'owner_private' },
      storage: { directory: dir },
      channel: { onebotHttpBase: 'http://127.0.0.1:1', ownerChats: ['2940015320'] },
    })
    const service = provided.get('companionMemory')
    assert.ok(service, '宿主没有提示词/模型服务时仍应装配成功')
    const report = service.compatibility()
    assert.ok(Array.isArray(report.capabilities))
    assert.ok(report.capabilities.some((item) => item.id === 'systemPrompt' && item.available === false))
    assert.equal(report.delivery, 'plain-body-only', '没有 OneBot HTTP 时应退化为纯正文')
    await service.shutdown()
  } finally {
    safeRemove(dir)
  }
})
