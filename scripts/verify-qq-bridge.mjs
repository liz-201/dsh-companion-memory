#!/usr/bin/env node
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--target')
if (flag < 0 || !process.argv[flag + 1]) throw new Error('Usage: node scripts/verify-qq-bridge.mjs --target <dsh-onebot-qq@0.9.3 directory>')
const source = resolve(process.argv[flag + 1])
const preview = mkdtempSync(join(tmpdir(), 'companion-bridge-review-'))
const paths = ['lib/index.js', 'lib/bridge.js', 'lib/inbound.js']
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (result.status !== 0) throw new Error(result.stdout + result.stderr)
  return result.stdout.trim()
}
try {
  cpSync(join(source, 'package.json'), join(preview, 'package.json'))
  cpSync(join(source, 'lib'), join(preview, 'lib'), { recursive: true })
  const before = paths.map(path => readFileSync(join(preview, path)))
  console.log(run(['scripts/patch-qq-bridge.mjs', '--target', preview, '--apply']))
  for (const path of [...paths, 'lib/companion-port.js']) run(['--check', join(preview, path)])
  // Test actual patched inbound gate order. Media decoding is deliberately outside this dry test.
  let code = readFileSync(join(preview, 'lib/inbound.js'), 'utf8')
  code = code.replace(/from '(\.\/[^']+)'/g, (_, name) => {
    const url = name === './media.js'
      ? 'data:text/javascript,export function extForInboundName(){throw new Error("media not in dry test")}'
      : pathToFileURL(resolve(preview, 'lib', name)).href
    return `from ${JSON.stringify(url)}`
  })
  const { InboundPipeline } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  const { createCompanionPort } = await import(pathToFileURL(join(preview, 'lib/companion-port.js')).href)
  let active = true, turns = 0, defaults = 0, defaultCommands = 0, sends = 0
  const companion = createCompanionPort({
    getService: () => active ? { accepts: chatId => chatId === 'private:123', handleInbound: async input => { turns++; await input.send('fixture reply', 'fixture-turn'); return { handled: true } } } : undefined,
    sendToChat: async () => { sends++; return ['456'] }, botAccountId: () => '888', sessionId: () => 'fixture-session',
  })
  const pipeline = new InboundPipeline({ companion, config: { ignoreSelf: true, botQQ: '888', requireMention: false, rateLimitPerMinute: 100, dedupWindowSeconds: 300 },
    selfId: () => '888', policy: { dmPolicy: 'open', allowAllUsers: true, adminUsers: ['123'] },
    sweepIdleChats: async () => {}, getChat: () => undefined, getSettings: () => ({}), media: { cleanupExpired: async () => {} },
    tryHandleCommand: async () => { defaultCommands++; return false }, buildBody: async text => text,
    dispatchFollowup: async () => { defaults++ }, log: () => {},
  })
  let seq = 0
  const sendInbound = (text, userId = '123') => pipeline.processInbound({ kind: 'private', userId, groupId: '', chatId: `private:${userId}`, raw: text, text, media: [], nickname: 'fixture', messageId: String(++seq) })
  await sendInbound('hello')
  assert.equal(turns, 1); assert.equal(sends, 1); assert.equal(defaults, 0)
  const previousCommands = defaultCommands
  await sendInbound('/fish status')
  assert.equal(turns, 2); assert.equal(defaultCommands, previousCommands, '/fish must precede the original command router')
  await sendInbound('other user', '999')
  assert.equal(turns, 2); assert.equal(defaults, 1)
  active = false
  await sendInbound('plugin disabled')
  assert.equal(defaults, 2)
  console.log('PASS: patched inbound dispatch, /fish order, owner scope, disable fallback, one send per handled turn; no network calls.')
  console.log(run(['scripts/patch-qq-bridge.mjs', '--target', preview, '--revert']))
  paths.forEach((path, index) => assert.deepEqual(readFileSync(join(preview, path)), before[index]))
  console.log('PASS: all original files restored byte-for-byte.')
} finally {
  const absolute = resolve(preview)
  if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.split(sep).at(-1).startsWith('companion-bridge-review-')) throw new Error('Unsafe preview cleanup')
  rmSync(absolute, { recursive: true, force: true, maxRetries: 3 })
}
