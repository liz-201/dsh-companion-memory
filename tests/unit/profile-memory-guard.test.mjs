import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPANION_ID, applyProfileFixes, findRow, inspectProfile, topLevelBlocks } from '../../scripts/profile-memory-guard.mjs'

const BUNDLE = '@vectorize-io/hindsight-coding-agents'

/** 造一个临时 DSH home，profile 内容由参数决定；返回 { home, packageFile, patchFile }。 */
function sandbox({ bundles = [COMPANION_ID], patch = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'memory-guard-'))
  const dir = join(home, 'profiles', 'desktop')
  mkdirSync(dir, { recursive: true })
  const packageFile = join(dir, 'package.json')
  writeFileSync(packageFile, `${JSON.stringify({ name: 'x', dsh: { profile: { bundles } } }, null, 2)}\n`)
  const patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, patch)
  return { home, packageFile, patchFile }
}

const codes = report => report.findings.map(finding => finding.code)

test('clean profile reports the external memory plugin as absent', () => {
  const { home } = sandbox({ patch: `- id: ${COMPANION_ID}\n  companion: blue-fish-main\n` })
  const report = inspectProfile({ home })
  assert.deepEqual(codes(report), ['external-memory-absent'])
  assert.equal(report.findings[0].level, 'ok')
})

test('an enabled external memory bundle is flagged, then removed and disabled', () => {
  const { home, packageFile, patchFile } = sandbox({
    bundles: [COMPANION_ID, BUNDLE],
    patch: `- id: ${COMPANION_ID}\n  companion: blue-fish-main\n- id: plugin-market\n  disabled: true\n`,
  })
  assert.deepEqual(codes(inspectProfile({ home })), ['external-memory-active'])

  const { changes } = applyProfileFixes({ home, stamp: 'test' })
  assert.equal(changes.length, 2)
  assert.ok(!readFileSync(packageFile, 'utf8').includes(BUNDLE))
  const patchText = readFileSync(patchFile, 'utf8')
  assert.match(patchText, /^- id: hindsight\n {2}disabled: true$/m)
  // 其余条目原样保留
  assert.match(patchText, new RegExp(`^- id: ${COMPANION_ID}\n {2}companion: blue-fish-main$`, 'm'))
  assert.match(patchText, /^- id: plugin-market\n {2}disabled: true$/m)

  const after = inspectProfile({ home })
  assert.deepEqual(codes(after), ['external-memory-absent'])
  assert.equal(after.findings[0].level, 'ok')
})

test('fixing twice is a no-op, and a bundle left in place is still neutralised by disabled: true', () => {
  const { home } = sandbox({ bundles: [COMPANION_ID, BUNDLE], patch: '' })
  assert.equal(applyProfileFixes({ home, stamp: 'first' }).changes.length, 2)
  assert.deepEqual(applyProfileFixes({ home, stamp: 'second' }).changes, [])

  // bundles 被别的设备加回来：patch 里已有的 disabled 行足够，只摘 bundle
  const { home: other } = sandbox({
    bundles: [COMPANION_ID, BUNDLE],
    patch: `- id: ${COMPANION_ID}\n  companion: blue-fish-main\n- id: hindsight\n  disabled: true\n`,
  })
  assert.deepEqual(codes(inspectProfile({ home: other })), ['external-memory-disabled'])
  assert.equal(applyProfileFixes({ home: other, stamp: 'third' }).changes.length, 1)
})

test('a hard-coded absolute chatSessionsFile is reported and commented out', () => {
  const patch = `- id: ${COMPANION_ID}\n  companion: blue-fish-main\n  chatSessionsFile: 'C:\\Users\\someone\\.dsh\\media\\onebot\\chat-sessions.json'\n`
  const { home, patchFile } = sandbox({ patch })
  const report = inspectProfile({ home })
  assert.deepEqual(codes(report), ['external-memory-absent', 'absolute-session-path'])
  assert.match(report.findings[1].detail, /C:\\Users\\someone/)

  applyProfileFixes({ home, stamp: 'test' })
  assert.deepEqual(codes(inspectProfile({ home })), ['external-memory-absent'])
  assert.doesNotMatch(readFileSync(patchFile, 'utf8'), /^\s*chatSessionsFile:/m)
})

test('a relative chatSessionsFile is left alone, and every write leaves a backup', () => {
  const patch = `- id: ${COMPANION_ID}\n  chatSessionsFile: media/onebot/chat-sessions.json\n`
  const { home, patchFile } = sandbox({ patch })
  assert.deepEqual(codes(inspectProfile({ home })), ['external-memory-absent'])
  assert.deepEqual(applyProfileFixes({ home, stamp: 'test' }).changes, [])
  assert.ok(!existsSync(`${patchFile}.bak-memory-test`))

  const dirty = sandbox({ bundles: [BUNDLE], patch: '' })
  const { backups } = applyProfileFixes({ home: dirty.home, stamp: 'stamp1' })
  assert.equal(backups.length, 2)
  for (const file of backups) {
    assert.ok(existsSync(file))
    assert.match(file, /\.bak-memory-stamp1$/)
  }
})

test('a missing patch file or unparsable package.json degrades to a warning instead of throwing', () => {
  const { home, packageFile } = sandbox({})
  rmSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
  assert.ok(codes(inspectProfile({ home })).includes('patch-missing'))

  writeFileSync(packageFile, '{ not json')
  const report = inspectProfile({ home })
  assert.ok(codes(report).includes('profile-json'))
  assert.ok(report.findings.some(finding => finding.level === 'fail'))
  assert.deepEqual(applyProfileFixes({ home, stamp: 'test' }).changes, [])
})

test('YAML row parsing ignores nested rows and matches the companion row exactly', () => {
  const lines = ['- id: a', '  nested:', '  - id: b', '- id: dsh-companion-memory', '  x: 1', '- id: c']
  assert.deepEqual(topLevelBlocks(lines).map(block => block.start), [0, 3, 5])
  assert.equal(findRow(lines, 'dsh-companion-memory').start, 3)
  assert.equal(findRow(lines, 'b'), null)
  assert.equal(findRow(lines, 'a').body.length, 2)
})
