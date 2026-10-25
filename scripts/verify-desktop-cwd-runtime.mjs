import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Context } from '../artifacts/desktop-cwd-runtime/node_modules/@deepseek-ai/cordis/lib/index.js'
const compat = await import(process.argv.includes('--installed')
  ? 'file:///C:/Users/33544/.dsh/profiles/desktop/node_modules/dsh-desktop-cwd-compat/index.mjs'
  : '../integration/desktop-cwd-compat/index.mjs')

// Use the actual installed Desktop's Cordis and prompt interpolation code,
// extracted read-only from app.asar. No model calls or live session writes.
const source = readFileSync(new URL('../artifacts/host-api/dsh-system-prompt.js', import.meta.url), 'utf8')
const start = source.indexOf('function interpolate(')
const end = source.indexOf('\n}', start) + 2
assert.ok(start >= 0 && end > start)
const interpolate = runInNewContext(`${source.slice(start, end)}; interpolate`, {
  VARIABLE_NAME: /^[a-z][a-z0-9_]*$/, GROUP_AT: /^\{\{([^{}]*)\}\}/,
})
const ctx = new Context()
ctx.provide('systemPrompt', {})
let directory = 'D:/dsh-workspace'
ctx.provide('workingDirectory', { get: () => directory })

// Confirm the original metadata creates exactly the pending state in the log.
let badActivated = false
const bad = ctx.plugin({ name: 'old-cwd-compat-regression', inject: { required: ['systemPrompt'], optional: ['workingDirectory'] }, apply: () => { badActivated = true } })
await new Promise(resolve => setTimeout(resolve, 25))
assert.equal(badActivated, false)
assert.deepEqual(Object.keys(bad.inject), ['required', 'optional'])
await bad.dispose()

const good = ctx.plugin(compat)
await good
assert.equal(good.state, 2, `Plugin must be active; state=${good.state}`)
const section = { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' }
const original = { sections: [section], variables: { provider: 'test', model: 'test' }, contexts: [], tools: [] }
assert.throws(() => interpolate(section, original.variables, 'section'), /unknown prompt variable/)
const context = { agent: { session: { header: { cwd: 'D:/original' } } } }
const assemble = () => ctx.waterfall('system-prompt/assemble', original, context, async () => original)
const fixed = await assemble()
assert.equal(interpolate(section, fixed.variables, 'section'), 'Your working directory is D:/dsh-workspace.')
directory = 'D:/switched-workspace'
assert.equal((await assemble()).variables.cwd, directory)
await good.dispose()
assert.equal((await assemble()).variables.cwd, undefined, 'Disposal must remove the listener')
const report = { testedInstalledCopy: process.argv.includes('--installed'), hostCordis: '4.0.5 from installed Desktop', originalPendingReproduced: true, compatibilityPluginActivated: true, realWaterfallAndRendererPassed: true, directoryChangePassed: true, disposalPassed: true }
writeFileSync(new URL('../artifacts/desktop-cwd-runtime-report.json', import.meta.url), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
