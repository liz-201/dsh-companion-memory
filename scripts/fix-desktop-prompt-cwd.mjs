import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(root, 'artifacts', 'desktop-cwd-fix')
const target = 'C:/Users/33544/.dsh/profiles/desktop/node_modules/dsh-purge/lib/identity.js'
const digest = text => createHash('sha256').update(text).digest('hex')
const manifestPath = join(directory, 'manifest.json')
if (process.argv.includes('--apply')) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const current = readFileSync(target, 'utf8')
  const patched = readFileSync(join(directory, 'identity.js'), 'utf8')
  assert.equal(digest(current), manifest.before, 'Installed file changed since preparation')
  assert.equal(digest(patched), manifest.after, 'Prepared patch changed')
  const backup = `${target}.cwd-fix-${Date.now()}.bak`
  copyFileSync(target, backup)
  writeFileSync(target, patched, 'utf8')
  assert.equal(digest(readFileSync(target, 'utf8')), manifest.after)
  console.log(JSON.stringify({ applied: true, target, backup }))
} else {
  const original = readFileSync(target, 'utf8')
  let patched = original
  const replace = (from, to) => {
    assert.equal(patched.split(from).length, 2, `Expected one match: ${from}`)
    patched = patched.replace(from, to)
  }
  replace('function overlayOfficialIdentity(sections) {', `function overlayOfficialIdentity(sections, variables = {}) {
  // Desktop hosts may no longer register cwd as a prompt variable.
  const cwdSuffix = typeof variables?.cwd === "string" && variables.cwd.trim()
    ? CWD_ONLY_SUFFIX
    : "The working directory is not available in this prompt; consult the current workspace context.";`)
  replace('out.push({ ...section, text: CWD_ONLY_SUFFIX });', 'out.push({ ...section, text: cwdSuffix });')
  replace('text: CWD_ONLY_SUFFIX,\n      order: 10200,', 'text: cwdSuffix,\n      order: 10200,')
  replace('overlayOfficialIdentity(sanitizeAssemblySections(sections))', 'overlayOfficialIdentity(sanitizeAssemblySections(sections), assembled.variables)')

  // Exercise the exact patched function, with unrelated identity predicates stubbed.
  const start = patched.indexOf('function overlayOfficialIdentity(')
  const end = patched.indexOf('\nfunction withoutHardcodedExec', start)
  const overlay = runInNewContext(`${patched.slice(start, end)}; overlayOfficialIdentity`, {
    CWD_ONLY_SUFFIX: 'Your working directory is {{cwd}}.',
    PERSONA_PREFIX_NAMES: new Set(), PERSONA_LEGACY_NAMES: new Set(),
    looksLikeOfficialIdentity: () => false,
    isCwdOnlyText: value => value === 'Your working directory is {{cwd}}.',
  })
  const suffix = { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' }
  for (const variables of [undefined, {}, { provider: 'p', model: 'm' }, { cwd: undefined }, { cwd: '' }]) {
    for (const sections of [[], [suffix]]) {
      const result = overlay(sections, variables)
      assert.ok(!result.at(-1).text.includes('{{cwd}}'))
    }
  }
  assert.equal(overlay([suffix], { cwd: 'D:/project' })[0].text, suffix.text)
  const custom = { name: 'deployment:persona-suffix', text: 'Keep my custom persona.' }
  assert.equal(overlay([custom], {})[0], custom)
  assert.equal(suffix.text, 'Your working directory is {{cwd}}.')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'identity.js'), patched)
  writeFileSync(manifestPath, JSON.stringify({ target, before: digest(original), after: digest(patched), tests: 'passed: absent, undefined, empty, available cwd; existing/absent suffix; custom text preserved' }, null, 2))
  console.log('Prepared minimal desktop cwd compatibility patch; regression checks passed.')
}
