import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompanionPort } from '../../integration/dsh-onebot-qq/companion-port.mjs'
import { HostModelCaller, streamFromHost } from '../../lib/adapters/dsh-adapter.js'

const inbound = { kind: 'private', chatId: 'private:123', userId: '123', messageId: 'm1', text: '你好', media: [] }

test('QQ port 使用已验证身份和桥发送回执，消费后不再启动默认回合', async () => {
  let received, sends = 0
  const service = { accepts: id => id === 'private:123', handleInbound: async input => {
    received = input
    const receipt = await input.send('你好', 'turn-1')
    assert.equal(receipt.kind, 'accepted')
    assert.equal(receipt.platformMessageId, '456')
    assert.equal(typeof receipt.atMs, 'number')
    return { handled: true, replySuppressed: true, outcome: { status: 'say-only', say: '你好' } }
  } }
  const port = createCompanionPort({ getService: () => service, sendToChat: async () => { sends++; return ['456'] }, botAccountId: () => '888', sessionId: () => 'session-1' })
  assert.equal(await port(inbound, false), true)
  assert.equal(received.botAccountId, '888')
  assert.equal(received.platformMessageKey, 'm1')
  assert.equal(received.sessionId, 'session-1')
  assert.equal(sends, 1)
})

test('QQ port 在服务卸载、其他用户、多媒体与身份未知时正常回落', async () => {
  let active = true
  const service = { accepts: id => id === 'private:123', handleInbound: async () => ({ handled: true }) }
  const options = { getService: () => active ? service : undefined, sendToChat: async () => [], botAccountId: () => '888', sessionId: () => undefined }
  const port = createCompanionPort(options)
  assert.equal(await port({ ...inbound, chatId: 'private:999' }), false)
  assert.equal(await port({ ...inbound, media: [{ kind: 'image' }] }), false)
  assert.equal(await port({ ...inbound, kind: 'group' }), false)
  assert.equal(await createCompanionPort({ ...options, botAccountId: () => undefined })(inbound), false)
  active = false
  assert.equal(await port(inbound), false)
})

test('/fish 在普通命令路由前消费，unknown 回执仍抑制默认回复', async () => {
  let calls = 0
  const port = createCompanionPort({ getService: () => ({ accepts: () => true, handleInbound: async input => {
    calls++
    const receipt = await input.send('状态', 'command')
    assert.equal(receipt.kind, 'unknown')
    return { handled: true }
  } }), sendToChat: async () => { throw new Error('transport timeout') }, botAccountId: () => '888', sessionId: () => undefined })
  const command = { ...inbound, text: '/fish status' }
  assert.equal(await port(command, true), true)
  assert.equal(await port(command, false), false)
  assert.equal(calls, 1)
})

test('宿主切换模型后下一轮重新解析 route', async () => {
  let model = 'first'
  const caller = new HostModelCaller({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model }) } })
  assert.equal((await caller.route()).model, 'first')
  model = 'second'
  assert.equal((await caller.route()).model, 'second')
})

test('思考关闭只使用模型声明的 effort，并识别宿主终止错误', async () => {
  let options
  const ctx = { llm: {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'none', name: '关闭' }, { id: 'high', name: '高' }] } }),
    stream: async function* (request) { options = request; yield { type: 'text-delta', text: '正文' }; yield { type: 'finish', reason: { kind: 'error' } } },
  } }
  await assert.rejects(async () => {
    for await (const chunk of streamFromHost(ctx, { provider: 'fixture', model: 'scripted', reasoningEffort: 'high' }, { turnId: 't', systemText: '人格', userText: '你好', thinking: 'disabled' })) assert.equal(chunk.text, '正文')
  }, /error/)
  assert.equal(options.reasoningEffort, 'none')
})
