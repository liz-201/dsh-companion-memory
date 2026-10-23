#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const targetFlag = args.indexOf('--target')
if (targetFlag < 0 || !args[targetFlag + 1]) throw new Error('Usage: node scripts/patch-qq-bridge.mjs --target <dsh-onebot-qq directory> [--apply|--revert]')
const target = resolve(args[targetFlag + 1])
const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-onebot-qq' || pkg.version !== '0.9.3') throw new Error('Only dsh-onebot-qq@0.9.3 is supported')
const digest = text => createHash('sha256').update(text).digest('hex')
const recordFile = join(target, '.companion-patch', 'manifest.json')

if (args.includes('--revert')) {
  const manifest = JSON.parse(readFileSync(recordFile, 'utf8'))
  for (const entry of manifest.files) {
    if (!['lib/index.js', 'lib/bridge.js', 'lib/inbound.js', 'lib/companion-port.js'].includes(entry.path)) throw new Error('Unexpected path in patch manifest')
    const current = existsSync(join(target, entry.path)) ? digest(readFileSync(join(target, entry.path))) : null
    if (current !== entry.before && current !== entry.after) throw new Error(`Changed since patch: ${entry.path}; refusing to overwrite`)
    if (entry.before !== null && digest(readFileSync(join(target, '.companion-patch', entry.path))) !== entry.before) throw new Error(`Backup checksum mismatch: ${entry.path}`)
  }
  for (const entry of manifest.files) {
    if (entry.before === null) { if (existsSync(join(target, entry.path))) unlinkSync(join(target, entry.path)) }
    else copyFileSync(join(target, '.companion-patch', entry.path), join(target, entry.path))
  }
  unlinkSync(recordFile)
  console.log('Companion bridge patch reverted; restart DSH to reload.')
  process.exit(0)
}
if (existsSync(recordFile)) {
  const manifest = JSON.parse(readFileSync(recordFile, 'utf8'))
  for (const entry of manifest.files) if (digest(readFileSync(join(target, entry.path))) !== entry.after) throw new Error(`Patched file changed: ${entry.path}`)
  console.log('Companion bridge patch already installed and checksums match.')
  process.exit(0)
}

const replacements = [
  ['lib/index.js', '    const bridge = new ChatBridge({\n        ctx,', "    const bridge = new ChatBridge({\n        ctx,\n        companion: () => { try { return ctx.get('companionMemory'); } catch { return undefined; } },"],
  ['lib/bridge.js', "import { tryHandleCommand as routeCommand, STEER_ACCEPTED_NOTICE } from './commands.js';", "import { tryHandleCommand as routeCommand, STEER_ACCEPTED_NOTICE } from './commands.js';\nimport { createCompanionPort } from './companion-port.js';"],
  ['lib/bridge.js', '        this.inbound = new InboundPipeline({', `        this.inbound = new InboundPipeline({
            companion: createCompanionPort({
                getService: () => deps.companion?.(),
                sendToChat: (chatId, text) => this.sendToChat(chatId, text),
                botAccountId: () => this.deps.connection.selfId,
                sessionId: chatId => this.chats.get(chatId)?.agent?.session?.id,
                log: (level, message) => this.deps.log(level, message),
            }),`],
  ['lib/inbound.js', '        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {', '        if (await this.ctx.companion?.(inbound, true)) return;\n        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {'],
  ['lib/inbound.js', '        const role = isAdmin ? \'admin\' : \'member\';', '        if (await this.ctx.companion?.(inbound, false)) return;\n        const role = isAdmin ? \'admin\' : \'member\';'],
]
const changed = new Map()
for (const [path, before, after] of replacements) {
  const original = changed.get(path)?.after ?? readFileSync(join(target, path), 'utf8')
  const text = original.replace(/\r\n/g, '\n')
  if (text.split(before).length !== 2) throw new Error(`Patch anchor mismatch: ${path}; no files changed`)
  changed.set(path, { before: changed.get(path)?.before ?? readFileSync(join(target, path)), after: text.replace(before, after) })
}
const port = 'lib/companion-port.js'
if (existsSync(join(target, port))) throw new Error('Unexpected companion-port.js already exists; refusing to overwrite')
changed.set(port, { before: null, after: readFileSync(join(root, 'integration/dsh-onebot-qq/companion-port.mjs'), 'utf8') })
if (!args.includes('--apply')) {
  console.log(`CHECK PASS: ${pkg.name}@${pkg.version}; ${changed.size} files ready. No files written.`)
  process.exit(0)
}
const manifest = { version: 1, package: pkg.name, packageVersion: pkg.version, appliedAt: new Date().toISOString(), files: [] }
for (const [path, change] of changed) {
  const backup = join(target, '.companion-patch', path)
  if (change.before !== null) { mkdirSync(dirname(backup), { recursive: true }); writeFileSync(backup, change.before) }
  manifest.files.push({ path, before: change.before === null ? null : digest(change.before), after: digest(change.after) })
}
// Backups and manifest are complete before the first active file is changed.
mkdirSync(dirname(recordFile), { recursive: true })
writeFileSync(recordFile, JSON.stringify(manifest, null, 2) + '\n')
try {
  for (const [path, change] of changed) writeFileSync(join(target, path), change.after)
} catch (error) {
  for (const [path, change] of changed) {
    if (change.before !== null) writeFileSync(join(target, path), change.before)
    else if (existsSync(join(target, path))) unlinkSync(join(target, path))
  }
  unlinkSync(recordFile)
  throw error
}
console.log(`APPLIED: ${changed.size} files; backups and SHA-256 manifest at ${recordFile}. Restart DSH to reload.`)
