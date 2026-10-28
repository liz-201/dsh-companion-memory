import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fiveHourLimit, runNightCloseout, verifyEvidence, createLiveDependencies } from '../../scripts/night-closeout.mjs'

const commit = 'a'.repeat(40)
const exhausted = (now = 1000000) => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 1000 } } })
const error = code => Object.assign(Error(code), { code })

function fixture(overrides = {}) {
  let time = 1000000
  const events = [], saved = []
  const options = { runId: 'night-test', cwd: resolve('night-test-repository'), stateDir: resolve('night-test-private'), execute: true,
    signoffPollMs: 1000, completionTimeoutMs: 4000, shutdownDelayMs: 3000, ...overrides }
  const auth = { version: 1, runId: options.runId, cwd: options.cwd, sessionIds: ['session-night-test'],
    authorizedAtMs: time - 1000, expiresAtMs: time + 120000, allowShutdown: true }
  const manifest = { version: 1, runId: options.runId, cwd: options.cwd, commit, reviewedAtMs: time - 500,
    tests: { exitCode: 0, commands: ['node --test example.test.mjs'], evidence: [{ path: 'artifacts/tests.tap', sha256: 'b'.repeat(64) }] } }
  const data = { auth, manifest, stop: null, complete: null, cancel: null, prior: null }
  const deps = {
    now: () => time,
    sleep: async ms => { events.push(`sleep:${ms}`); time += ms },
    load: async name => {
      if (name === 'authorization.json') return data.auth
      if (name === 'reviewed-commit.json') return data.manifest
      if (name === 'tasks-complete.json') return data.complete ?? { version: 1, runId: options.runId, commit, completedAtMs: time, allTasksStopped: true }
      if (name === 'stop-admission.json' && data.stop) return data.stop
      if (name === 'cancel-closeout.json' && data.cancel) return data.cancel
      if (name === 'status.json' && data.prior) return data.prior
      throw error('ENOENT')
    },
    readLimits: async () => { events.push('quota'); return exhausted(time) },
    save: async value => { saved.push(structuredClone(value)) },
    writeStop: async value => { events.push('stop'); data.stop = value; time++; return value },
    notify: async () => { events.push('notify') },
    reportBlocked: async () => { events.push('blocked-notify') },
    verifyEvidence: async () => { events.push('evidence') },
    inspectGit: async () => { events.push('git'); return { commit, dirty: false } },
    idle: async () => { events.push('idle'); return true },
    syncCloud: async () => { events.push('sync'); return { lastSyncAtMs: time, uploadQueued: true } },
    push: async value => { assert.equal(value, commit); events.push('push'); return commit },
    remoteHead: async () => { events.push('remote-head'); return commit },
    shutdown: async () => { events.push('shutdown') },
  }
  return { options, deps, events, saved, data }
}

test('only a current codex 300 minute window at 100 percent is a trigger', () => {
  assert.equal(fiveHourLimit(exhausted(), 1000000).windowDurationMins, 300)
  for (const value of [undefined, {}, { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2000 } } },
    { rateLimits: { limitId: 'codex_other', primary: exhausted().rateLimits.primary } },
    { rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 2000 } } },
    { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1000 } } },
    { rateLimits: { primary: { usedPercent: '100', windowDurationMins: 300, resetsAt: 2000 } } }]) assert.equal(fiveHourLimit(value, 1000000), null)
  assert.equal(fiveHourLimit({ rateLimitsByLimitId: { codex: { secondary: exhausted().rateLimits.primary } } }, 1000000).usedPercent, 100)
})

test('dry-run and check-once never stop admission, send, sync, push, save, or shut down', async () => {
  for (const values of [{ execute: false }, { execute: true, checkOnce: true }]) {
    const f = fixture(values)
    const result = await runNightCloseout(f.options, f.deps)
    assert.equal(result.phase, 'dry-run')
    assert.equal(result.quotaExhausted, true)
    assert.deepEqual(f.events, ['quota']) // A completion predating a new stop cannot authorize effects.
    assert.deepEqual(f.saved, [])
  }
})

test('confirmed exhaustion stops new tasks, waits for signoff, syncs, pushes the reviewed commit, rechecks, then shuts down', async () => {
  const f = fixture()
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.phase, 'shutdown-requested')
  assert.deepEqual(f.events.slice(0, 3), ['quota', 'stop', 'notify'])
  assert.ok(f.events.indexOf('sync') > f.events.indexOf('idle'))
  assert.ok(f.events.indexOf('push') > f.events.indexOf('sync'))
  assert.ok(f.events.lastIndexOf('remote-head') > f.events.indexOf('push'))
  assert.equal(f.events.at(-1), 'shutdown')
  assert.equal(f.events.filter(value => value === 'sync').length, 2)
  assert.equal(f.events.filter(x => x === 'sleep:1000').length, 3)
  assert.equal(f.saved.at(-1).reviewedCommit, commit)
})

test('quota read failures are unknown and cannot trigger any closeout effects', async () => {
  const f = fixture({ checkOnce: true })
  f.deps.readLimits = async () => { throw Error('private provider response') }
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.quotaExhausted, false)
  assert.equal(result.error, 'NIGHT_QUOTA_UNAVAILABLE')
  assert.deepEqual(f.events, [])
})

test('monitoring recovers from a failed read without treating a fresh reset as exhaustion', async () => {
  const f = fixture({ pollMs: 1000 })
  let calls = 0
  f.deps.readLimits = async () => {
    if (++calls === 1) throw Error('unavailable')
    const value = exhausted(f.deps.now())
    if (calls === 2) value.rateLimits.primary.usedPercent = 1
    return value
  }
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(calls, 3)
  assert.equal(result.phase, 'shutdown-requested')
  assert.equal(result.error, undefined)
  assert.ok(f.events.indexOf('stop') >= 2)
})

for (const [name, modify, code] of [
  ['dirty worktree', f => { f.deps.inspectGit = async () => ({ commit, dirty: true }) }, 'NIGHT_DIRTY_WORKTREE'],
  ['unreviewed HEAD', f => { f.deps.inspectGit = async () => ({ commit: 'c'.repeat(40), dirty: false }) }, 'NIGHT_UNREVIEWED_HEAD'],
  ['running DSH task', f => { f.deps.idle = async () => false }, 'NIGHT_TASKS_ACTIVE'],
  ['altered evidence', f => { f.deps.verifyEvidence = async () => { throw error('NIGHT_EVIDENCE_CHANGED') } }, 'NIGHT_EVIDENCE_CHANGED'],
  ['failed tests', f => { f.data.manifest.tests.exitCode = 1 }, 'NIGHT_REVIEW_INVALID'],
  ['another run signoff', f => { f.data.manifest.runId = 'old-night' }, 'NIGHT_REVIEW_INVALID'],
  ['pre-stop completion', f => { f.data.complete = { version: 1, runId: f.options.runId, commit, allTasksStopped: true, completedAtMs: f.deps.now() } }, 'NIGHT_TASKS_NOT_COMPLETE'],
]) test(`${name} prevents upload, push and shutdown`, async () => {
  const f = fixture()
  modify(f)
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.phase, 'blocked')
  assert.equal(result.error, 'NIGHT_SIGNOFF_TIMEOUT')
  assert.ok(f.saved.some(state => state.blockedBy === code))
  assert.ok(!f.events.some(value => ['sync', 'push', 'shutdown'].includes(value)))
  assert.equal(f.events.at(-1), 'blocked-notify')
})

test('cloud failure blocks push and shutdown without disclosing its response body', async () => {
  const f = fixture()
  f.deps.syncCloud = async () => { throw Error('https://secret.invalid/?token=private') }
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.phase, 'blocked')
  assert.equal(result.error, 'NIGHT_OPERATION_FAILED')
  assert.ok(!f.events.includes('push'))
  assert.ok(!f.events.includes('shutdown'))
  assert.ok(!JSON.stringify(f.saved).includes('private'))
})

test('a push failure or a different remote HEAD prevents shutdown', async () => {
  for (const kind of ['push-failure', 'push-mismatch', 'later-remote-change']) {
    const f = fixture()
    if (kind === 'push-failure') f.deps.push = async () => { throw error('NIGHT_GIT_FAILED') }
    if (kind === 'push-mismatch') f.deps.push = async () => 'c'.repeat(40)
    if (kind === 'later-remote-change') f.deps.remoteHead = async () => 'c'.repeat(40)
    const result = await runNightCloseout(f.options, f.deps)
    assert.equal(result.phase, 'blocked')
    assert.ok(!f.events.includes('shutdown'))
  }
})

test('a dirty edit arriving during upload stops before push', async () => {
  const f = fixture()
  f.deps.syncCloud = async () => { f.deps.inspectGit = async () => ({ commit, dirty: true }); return {} }
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.error, 'NIGHT_DIRTY_WORKTREE')
  assert.ok(!f.events.includes('push'))
  assert.ok(!f.events.includes('shutdown'))
})

test('cancellation during the script countdown cannot request an OS shutdown', async () => {
  const f = fixture()
  f.deps.sleep = async () => { f.data.cancel = { runId: f.options.runId } }
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.error, 'NIGHT_CANCELLED')
  assert.ok(!f.events.includes('shutdown'))
})

test('authorization expiry or revocation blocks all later actions', async () => {
  const f = fixture()
  f.deps.syncCloud = async () => { f.data.auth.allowShutdown = false; return {} }
  const result = await runNightCloseout(f.options, f.deps)
  assert.equal(result.error, 'NIGHT_AUTHORIZATION_INVALID')
  assert.ok(!f.events.includes('push'))
  assert.ok(!f.events.includes('shutdown'))
  f.data.auth.allowShutdown = true; f.data.auth.expiresAtMs = f.deps.now()
  await assert.rejects(runNightCloseout(f.options, f.deps), { code: 'NIGHT_AUTHORIZATION_INVALID' })
})

test('restarting a completed same-night request never resubmits shutdown', async () => {
  const f = fixture()
  f.data.prior = { version: 1, runId: f.options.runId, phase: 'shutdown-requested' }
  assert.equal((await runNightCloseout(f.options, f.deps)).phase, 'already-requested')
  assert.deepEqual(f.events, [])
  f.data.prior.phase = 'shutdown-requesting'
  assert.equal((await runNightCloseout(f.options, f.deps)).error, 'NIGHT_SHUTDOWN_OUTCOME_UNKNOWN')
  assert.deepEqual(f.events, [])
})

test('an interrupted same-night stop can resume even after the quota resets, while another night cannot trigger it', async () => {
  const f = fixture()
  f.data.stop = { version: 1, runId: f.options.runId, triggeredAtMs: f.deps.now() - 100, quota: exhausted().rateLimits.primary }
  f.deps.writeStop = async value => { assert.equal(value.triggeredAtMs, f.data.stop.triggeredAtMs); return value }
  f.deps.readLimits = async () => { assert.fail('a confirmed prior stop should not be reinterpreted after reset') }
  assert.equal((await runNightCloseout(f.options, f.deps)).phase, 'shutdown-requested')
  const next = fixture({ checkOnce: true })
  next.data.stop = { ...f.data.stop, runId: 'another-night' }
  next.deps.readLimits = async () => ({ rateLimits: { primary: { ...exhausted().rateLimits.primary, usedPercent: 1 } } })
  assert.equal((await runNightCloseout(next.options, next.deps)).quotaExhausted, false)
  assert.deepEqual(next.events, [])
})

test('new edits in the countdown and a failed final memory flush both prevent shutdown', async () => {
  const f = fixture()
  const sleep = f.deps.sleep
  f.deps.sleep = async ms => { await sleep(ms); f.deps.inspectGit = async () => ({ commit, dirty: true }) }
  assert.equal((await runNightCloseout(f.options, f.deps)).error, 'NIGHT_DIRTY_WORKTREE')
  assert.ok(!f.events.includes('shutdown'))
  const next = fixture()
  let calls = 0
  next.deps.syncCloud = async () => { if (++calls === 2) throw error('NIGHT_CLOUD_SYNC_FAILED'); return {} }
  assert.equal((await runNightCloseout(next.options, next.deps)).error, 'NIGHT_CLOUD_SYNC_FAILED')
  assert.ok(next.events.includes('push'))
  assert.ok(!next.events.includes('shutdown'))
})

async function files(t) {
  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(join(parent, 'night-closeout-'))
  const cwd = join(directory, 'repo')
  await mkdir(cwd)
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), parent)
    assert.match(basename(directory), /^night-closeout-[a-z0-9]+$/i)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, cwd }
}

test('evidence must match bytes and stay inside the reviewed worktree, including junction resolution', async t => {
  const { directory, cwd } = await files(t)
  await writeFile(join(cwd, 'passed.tap'), '# pass 12\n# fail 0\n')
  const hash = createHash('sha256').update(await readFile(join(cwd, 'passed.tap'))).digest('hex')
  await verifyEvidence(cwd, [{ path: 'passed.tap', sha256: hash }])
  await assert.rejects(verifyEvidence(cwd, [{ path: 'passed.tap', sha256: 'f'.repeat(64) }]), { code: 'NIGHT_EVIDENCE_CHANGED' })
  await mkdir(join(directory, 'outside'))
  await writeFile(join(directory, 'outside', 'outside.tap'), '# pass 999')
  await assert.rejects(verifyEvidence(cwd, [{ path: '../outside/outside.tap', sha256: hash }]), { code: 'NIGHT_EVIDENCE_INVALID' })
  await symlink(join(directory, 'outside'), join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyEvidence(cwd, [{ path: 'linked/outside.tap', sha256: hash }]), { code: 'NIGHT_EVIDENCE_INVALID' })
})

test('the live API adapter exports only with auto-upload queued and waits beyond a stale/busy response', async () => {
  let time = 1000000, statuses = 0
  const paths = []
  const d = createLiveDependencies({ cwd: '.', stateDir: '.' }, {
    now: () => time, sleep: async ms => { time += ms },
    connect: async () => ({ url: new URL('http://127.0.0.1:2222/?token=not-logged'), cookie: 'private-cookie' }),
    fetch: async (url, init) => {
      paths.push(url.pathname)
      assert.equal(init.headers.cookie, 'private-cookie')
      if (url.pathname.endsWith('/manage')) return new Response('<script>const token="private-action", x=1;</script>')
      assert.equal(init.headers['x-companion-token'], 'private-action')
      if (url.pathname.endsWith('/export')) return Response.json({ upload: 'queued', download: '/not-logged' })
      if (url.pathname.endsWith('/sync')) return Response.json({ busy: true })
      return Response.json({ enabled: true, connected: true, ready: true, busy: ++statuses === 1,
        error: null, lastSyncAtMs: statuses === 1 ? time - 100 : time })
    },
  })
  const result = await d.syncCloud()
  assert.equal(result.uploadQueued, true)
  assert.equal(statuses, 2)
  assert.deepEqual(paths.slice(0, 3), ['/companion-memory/manage', '/companion-memory/api/export', '/companion-memory/api/sync'])
  assert.ok(!JSON.stringify(result).includes('private'))
})

test('disabled auto-upload never becomes a false successful cloud closeout', async () => {
  const d = createLiveDependencies({ cwd: '.', stateDir: '.' }, {
    connect: async () => ({ url: new URL('http://127.0.0.1:2222/'), cookie: 'cookie' }),
    fetch: async url => url.pathname.endsWith('/manage') ? new Response('const token="action"') : Response.json({ upload: 'disabled' }),
  })
  await assert.rejects(d.syncCloud(), { code: 'NIGHT_AUTO_UPLOAD_DISABLED' })
})

test('the live adapter reads only account rate limits and closes the CLI client', async () => {
  const calls = []
  const d = createLiveDependencies({ cwd: '.', stateDir: '.' }, { codexFactory: () => ({
    initialize: async () => calls.push('initialize'),
    rpc: async method => { calls.push(method); return exhausted() },
    close: () => calls.push('close'),
  }) })
  await d.readLimits()
  assert.deepEqual(calls, ['initialize', 'account/rateLimits/read', 'close'])
})

test('the git adapter pushes only the signed commit after fetching and proving remote ancestry', async t => {
  const { cwd } = await files(t)
  const calls = []
  const d = createLiveDependencies({ cwd, stateDir: cwd }, { exec: async (command, args) => {
    assert.equal(command, 'git'); calls.push(args)
    return { stdout: args[0] === 'ls-remote' ? `${commit}\trefs/heads/main\n` : '' }
  } })
  assert.equal(await d.push(commit), commit)
  assert.deepEqual(calls, [
    ['fetch', '--no-tags', 'origin', 'main'], ['merge-base', '--is-ancestor', 'FETCH_HEAD', commit],
    ['push', 'origin', `${commit}:refs/heads/main`], ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
  ])
  assert.ok(!JSON.stringify(calls).includes('--force'))
})

test('the Windows adapter never uses a nonzero shutdown timeout or force switch', async () => {
  const calls = []
  const d = createLiveDependencies({ cwd: '.', stateDir: '.' }, { platform: 'win32', exec: async (...args) => { calls.push(args); return { stdout: '' } } })
  await d.shutdown()
  assert.equal(calls[0][0], 'shutdown.exe')
  assert.deepEqual(calls[0][1], ['/s', '/t', '0'])
})
