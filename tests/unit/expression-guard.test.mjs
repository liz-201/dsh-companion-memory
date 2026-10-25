import test from 'node:test'
import assert from 'node:assert/strict'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { projectExpression } from '../../lib/domain/expression-plan.js'
import { guardExpression } from '../../lib/expression/repair.js'
import { guardDesktopStream } from '../../lib/adapters/desktop-expression.js'
const plan = text => projectExpression({ state: initialSnapshot('p', 'gentle', 'v1', 1), userText: text, nowMs: 1 })

test('A14 / A15: task modes preserve exact JSON, code, numbers and negation', async () => {
  for (const [input, text] of [['只输出JSON', '{"value":1.25}'], ['写代码并列出10项步骤', '不是明天，是周五；金额1.25\n```js\nconst x=1\n```']]) {
    const result = await guardExpression(text, plan(input))
    assert.equal(result.text, text)
  }
  const result = await guardExpression('当前心情：不是明天，是周五；金额1.25', plan('你怎么样'), { repair: async () => '明天，金额125' })
  assert.equal(result.status, 'blocked')
})
test('A13: report-like chat is checked, and unsupported emotional reports cannot pass', async () => {
  assert.equal((await guardExpression('当前心情：心情平稳', plan('你好'))).status, 'blocked')
  assert.equal((await guardExpression('具体来说：\n- **一点** 内容', plan('你好'))).status, 'degraded')
})
test('A12 / A33: meme cooldown and unsupported real-world history are hard checks', async () => {
  const p = plan('你好')
  p.restrictedMemes = ['劳资蜀道三']
  assert.equal((await guardExpression('劳资蜀道三', p)).status, 'blocked')
  for (const text of ['我今天出门看了看。', '我们昨晚一起看电影的时候，你还笑了。']) assert.equal((await guardExpression(text, p)).status, 'blocked')
})
test('A16 / A17: stream buffers text before guard, preserves tools and usage, and honors cancellation', async () => {
  let checked = false
  async function* source() {
    yield { type: 'text-delta', index: 0, text: '你好' }
    yield { type: 'text-delta', index: 0, text: '呀' }
    yield { type: 'tool-call-delta', index: 1, id: 't', name: 'test', arguments: '{}' }
    yield { type: 'usage', usage: { inputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const output = []
  for await (const chunk of guardDesktopStream(source(), async text => { assert.equal(output.length, 0); checked = true; return text })) { assert.equal(checked, true); output.push(chunk) }
  assert.equal(output.filter(x => x.type === 'usage').length, 1)
  assert.equal(output[1].id, 't')
  assert.equal(output[0].text, '你好呀')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(async () => { for await (const chunk of guardDesktopStream(source(), async x => x, controller.signal)) assert.fail(chunk) })
})
test('rewriting preserves separate block indices and invalidates provider replay metadata for changed text', async () => {
  async function* source() {
    yield { type: 'text-delta', index: 0, text: '甲' }
    yield { type: 'text-delta', index: 1, text: '乙' }
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { opaque: 'old' } }
  }
  const output = []
  for await (const chunk of guardDesktopStream(source(), async text => `${text}。`)) output.push(chunk)
  assert.deepEqual(output.slice(0, 2).map(x => [x.index, x.text]), [[0, '甲。'], [1, '乙。']])
  assert.equal(output.at(-1).replayState, undefined)
})
