import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'C:/Users/33544/.dsh/profiles/desktop'
const source = join(root, 'integration', 'desktop-cwd-compat')
const stage = join(root, 'artifacts', 'desktop-cwd-compat-install')
const targetPackage = join(profile, 'package.json')
const hash = value => createHash('sha256').update(value).digest('hex')
const files = ['index.mjs', 'package.json', 'cordis.patch.yml']
if (process.argv.includes('--apply')) {
  const plan = JSON.parse(readFileSync(join(stage, 'plan.json'), 'utf8'))
  assert.equal(hash(readFileSync(targetPackage)), plan.before, 'Profile changed; prepare again before applying')
  const updated = readFileSync(join(stage, 'profile-package.json'))
  assert.equal(hash(updated), plan.after)
  for (const file of files) assert.equal(hash(readFileSync(join(source, file))), plan.files[file])
  const destination = join(profile, 'node_modules', 'dsh-desktop-cwd-compat')
  mkdirSync(destination, { recursive: true })
  for (const file of files) copyFileSync(join(source, file), join(destination, file))
  const backup = `${targetPackage}.cwd-compat-${Date.now()}.bak`
  copyFileSync(targetPackage, backup)
  writeFileSync(targetPackage, updated)
  assert.equal(hash(readFileSync(targetPackage)), plan.after)
  for (const file of files) assert.equal(hash(readFileSync(join(destination, file))), plan.files[file])
  console.log(JSON.stringify({ installed: destination, profile: targetPackage, backup }))
} else {
  const before = readFileSync(targetPackage)
  const pkg = JSON.parse(before)
  pkg.dependencies ??= {}
  pkg.dependencies['dsh-desktop-cwd-compat'] = `link:${source.replaceAll('\\', '/')}`
  assert.ok(Array.isArray(pkg.dsh?.profile?.bundles), 'Unknown profile bundle format')
  if (!pkg.dsh.profile.bundles.includes('dsh-desktop-cwd-compat')) pkg.dsh.profile.bundles.push('dsh-desktop-cwd-compat')
  const updated = JSON.stringify(pkg, null, 2) + '\n'
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'profile-package.json'), updated)
  writeFileSync(join(stage, 'plan.json'), JSON.stringify({ before: hash(before), after: hash(updated), files: Object.fromEntries(files.map(file => [file, hash(readFileSync(join(source, file)))])) }, null, 2))
  console.log('Prepared: add only the local cwd compatibility package and its bundle; preserve all other profile settings.')
}
