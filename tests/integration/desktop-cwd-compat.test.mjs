import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { apply } from '../../integration/desktop-cwd-compat/index.mjs'

function mount(service) {
  let listener
  apply({ get: () => service, on(name, fn, options) {
    assert.equal(name, 'system-prompt/assemble')
    assert.equal(options.global, true)
    listener = fn
  } })
  return listener
}

test('legacy desktop cwd references render using the effective session directory', async () => {
  const hostSource = new URL('../../artifacts/host-api/dsh-system-prompt.js', import.meta.url)
  let interpolate = (section, variables) => section.text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error('unknown prompt variable')
    return variables[name]
  })
  if (existsSync(hostSource)) {
    const source = readFileSync(hostSource, 'utf8')
    const start = source.indexOf('function interpolate(')
    const end = source.indexOf('\n}', start) + 2
    assert.ok(start >= 0 && end > start)
    interpolate = runInNewContext(`${source.slice(start, end)}; interpolate`, { VARIABLE_NAME: /^[a-z][a-z0-9_]*$/, GROUP_AT: /^\{\{([^{}]*)\}\}/ })
  }
  const section = { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' }
  const original = { sections: [section], variables: { provider: 'test', model: 'test' } }
  assert.throws(() => interpolate(section, original.variables, 'section'), /unknown prompt variable/)
  let current = 'D:/project-a'
  const listener = mount({ get: () => current })
  const context = { agent: { session: { header: { cwd: 'D:/original' } } } }
  const fixed = await listener(original, context, async () => original)
  assert.equal(interpolate(section, fixed.variables, 'section'), 'Your working directory is D:/project-a.')
  current = 'D:/project-b'
  const next = await listener(original, context, async () => original)
  assert.equal(next.variables.cwd, 'D:/project-b')
  assert.equal(original.variables.cwd, undefined)
  assert.equal(fixed.variables.provider, 'test')
})

test('preset values, absent workspaces and agent-scoped directory services are handled', async () => {
  const listener = mount(null)
  const original = { variables: { cwd: 'D:/preset' } }
  assert.equal(await listener(original, {}, async () => original), original)
  assert.equal((await listener({}, { agent: { session: { header: { cwd: 'D:/session' } } } })).variables.cwd, 'D:/session')
  assert.match((await listener({}, {})).variables.cwd, /unavailable/)
  assert.equal((await listener({}, { agent: { session: {}, ctx: { get: () => ({ get: () => 'D:/agent' }) } } })).variables.cwd, 'D:/agent')
})
