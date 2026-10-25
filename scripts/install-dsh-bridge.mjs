import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'integration', 'codex-bridge')
const profile = join(homedir(), '.dsh', 'profiles', 'desktop')
const target = join(profile, 'package.json')
const stage = join(root, 'artifacts', 'codex-bridge-install')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['index.mjs', 'package.json', 'cordis.patch.yml']

if (process.argv.includes('--apply')) {
  const plan = JSON.parse(readFileSync(join(stage, 'plan.json'), 'utf8'))
  assert.equal(hash(readFileSync(target)), plan.before, 'Profile changed; prepare again')
  const updated = readFileSync(join(stage, 'profile-package.json'))
  assert.equal(hash(updated), plan.after)
  for (const file of files) assert.equal(hash(readFileSync(join(source, file))), plan.files[file])
  const destination = join(profile, 'node_modules', 'dsh-codex-bridge')
  if (existsSync(destination)) assert.equal(realpathSync(destination), realpathSync(source), 'Existing bridge package belongs to another source')
  else symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  const backup = `${target}.codex-bridge-${Date.now()}.bak`
  copyFileSync(target, backup)
  writeFileSync(target, updated)
  console.log(JSON.stringify({ installed: destination, backup, activation: 'DSH profile reload/restart required' }))
} else {
  const before = readFileSync(target)
  const pkg = JSON.parse(before)
  assert.ok(Array.isArray(pkg.dsh?.profile?.bundles), 'Unknown DSH profile format')
  pkg.dependencies ??= {}
  pkg.dependencies['dsh-codex-bridge'] = `link:${source.replaceAll('\\', '/')}`
  if (!pkg.dsh.profile.bundles.includes('dsh-codex-bridge')) pkg.dsh.profile.bundles.push('dsh-codex-bridge')
  const updated = JSON.stringify(pkg, null, 2) + '\n'
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'profile-package.json'), updated)
  writeFileSync(join(stage, 'plan.json'), JSON.stringify({ before: hash(before), after: hash(updated), files: Object.fromEntries(files.map(file => [file, hash(readFileSync(join(source, file)))])) }, null, 2))
  console.log('Prepared standalone dsh-codex-bridge link and bundle. Existing profile settings are preserved.')
}
