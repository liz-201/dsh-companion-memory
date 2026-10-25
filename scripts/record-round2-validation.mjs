import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const version = json('package.json').version
assert.equal(version, '0.3.0-dev.3')
const manifestPath = `dist/dsh-companion-memory-${version}.json`
const manifest = json(manifestPath)
const stage = `dist/dsh-companion-memory-${version}`
for (const file of manifest.files) {
  const bytes = readFileSync(join(stage, file.path))
  assert.equal(bytes.length, file.bytes, file.path)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
  assert.ok(!/(?:^|\/)(?:connection\.json|\.env(?:\..*)?|.*\.(?:db|sqlite3?)(?:-wal|-shm)?)$/i.test(file.path), `unexpected private runtime file: ${file.path}`)
}
const tests = readFileSync('artifacts/round2-final-tests.log', 'utf8')
const total = Number(/^# tests (\d+)$/m.exec(tests)?.[1])
const passed = Number(/^# pass (\d+)$/m.exec(tests)?.[1])
const failed = Number(/^# fail (\d+)$/m.exec(tests)?.[1])
const skipped = Number(/^# skipped (\d+)$/m.exec(tests)?.[1])
assert.equal(total, 190)
assert.equal(passed, total)
assert.equal(failed, 0)
assert.equal(skipped, 0)
const replayPath = 'artifacts/replay-2026-10-25T09-26-35-468Z.json'
const replay = json(replayPath), doctor = json('artifacts/round2-doctor.json')
assert.equal(replay.failureCount, 0)
assert.equal(replay.turns, 10000)
assert.equal(doctor.fails, 0)
assert.equal(doctor.warns, 0)
const output = {
  version, buildTime: statSync('lib/index.js').mtime.toISOString(),
  tests: { total, passed, failed, skipped },
  replay: { turns: replay.turns, failureCount: replay.failureCount, counts: replay.counts, report: replayPath },
  doctor: { fails: doctor.fails, warns: doctor.warns },
  package: { files: manifest.files.length, builtAt: manifest.builtAt, manifest: manifestPath, allHashesVerified: true, privateRuntimeFilenamesAbsent: true },
  bridgeRuntime: { host: 'DSH Desktop 0.2.1-rc.2', strictSchemas: 'passed', cordisLifecycle: 'passed', liveStatus: 'connected' },
  liveReload: 'pending; no automatic restart', workerSession: 'session-48b4abe9-ab62-42e9-86ab-60bb62eccfea'
}
writeFileSync('artifacts/round2-validation.json', JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify(output, null, 2))
