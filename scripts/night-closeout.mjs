import { readFile, writeFile, open, unlink, mkdir, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexAppServerClient } from './codex-app-server-client.mjs'
import { DshBridgeClient } from './dsh-bridge-client.mjs'
import { createStateWriter } from './codex-worker-state.mjs'

const exec = promisify(execFile)
const MAX_AGE = 12 * 3600000
const REPOSITORY = 'https://github.com/liz-201/dsh-companion-memory.git'
const fail = code => { throw Object.assign(Error(code), { code }) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const clock = value => Number.isSafeInteger(value) && value > 0
const record = async file => JSON.parse(await readFile(file, 'utf8'))
const safeFailure = error => /^NIGHT_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'NIGHT_OPERATION_FAILED'

/** A failed read or an exhausted weekly/other-model bucket is never a five-hour trigger. */
export function fiveHourLimit(result, nowMs = Date.now()) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits
  if (!bucket || bucket.limitId && bucket.limitId !== 'codex') return null
  const window = [bucket.primary, bucket.secondary].find(value => value?.windowDurationMins === 300
    && Number.isFinite(value.usedPercent) && value.usedPercent >= 100
    && Number.isSafeInteger(value.resetsAt) && value.resetsAt * 1000 > nowMs)
  return window ? { limitId: 'codex', usedPercent: window.usedPercent, windowDurationMins: 300, resetsAt: window.resetsAt } : null
}

export function validateAuthorization(auth, options, nowMs) {
  if (auth?.version !== 1 || auth.runId !== options.runId || !samePath(auth.cwd ?? '', options.cwd)
    || auth.allowShutdown !== true || !clock(auth.authorizedAtMs) || auth.authorizedAtMs > nowMs
    || !clock(auth.expiresAtMs) || auth.expiresAtMs <= nowMs || auth.expiresAtMs - auth.authorizedAtMs > MAX_AGE
    || !Array.isArray(auth.sessionIds) || !auth.sessionIds.length
    || auth.sessionIds.some(id => typeof id !== 'string' || !/^session-[\w.-]{1,152}$/.test(id))) fail('NIGHT_AUTHORIZATION_INVALID')
  return auth
}

export function validateSignoff(manifest, complete, auth, trigger, nowMs) {
  if (manifest?.version !== 1 || manifest.runId !== auth.runId || !samePath(manifest.cwd ?? '', auth.cwd)
    || !/^[a-f0-9]{40}$/.test(manifest.commit ?? '') || !clock(manifest.reviewedAtMs)
    || manifest.reviewedAtMs < auth.authorizedAtMs || manifest.reviewedAtMs > nowMs
    || manifest.tests?.exitCode !== 0 || !Array.isArray(manifest.tests.commands) || !manifest.tests.commands.length
    || manifest.tests.commands.some(value => typeof value !== 'string' || !value.trim())
    || !Array.isArray(manifest.tests.evidence) || !manifest.tests.evidence.length
    || manifest.tests.evidence.some(value => typeof value.path !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256 ?? ''))) fail('NIGHT_REVIEW_INVALID')
  if (complete?.version !== 1 || complete.runId !== auth.runId || complete.commit !== manifest.commit
    || complete.allTasksStopped !== true || !clock(complete.completedAtMs)
    || complete.completedAtMs <= trigger.triggeredAtMs || complete.completedAtMs > nowMs) fail('NIGHT_TASKS_NOT_COMPLETE')
  return manifest.commit
}

export async function verifyEvidence(cwd, evidence) {
  const base = await realpath(cwd)
  for (const entry of evidence) {
    if (isAbsolute(entry.path)) fail('NIGHT_EVIDENCE_INVALID')
    const file = await realpath(resolve(base, entry.path))
    const part = relative(base, file)
    if (part === '..' || part.startsWith('..\\') || part.startsWith('../') || isAbsolute(part)) fail('NIGHT_EVIDENCE_INVALID')
    if (sha(await readFile(file)) !== entry.sha256) fail('NIGHT_EVIDENCE_CHANGED')
  }
}

export function createLiveDependencies(options, io = {}) {
  const run = io.exec ?? exec, now = io.now ?? Date.now, sleep = io.sleep ?? delay, request = io.fetch ?? fetch
  const gitPrefix = []
  if (options.gitProxy) {
    const proxy = new URL(options.gitProxy)
    if (proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(proxy.hostname) || proxy.username || proxy.password) fail('NIGHT_OPTIONS_INVALID')
    gitPrefix.push('-c', `http.proxy=${proxy.href}`, '-c', 'http.sslBackend=openssl', '-c', 'http.version=HTTP/1.1')
  }
  const git = async args => {
    try { return (await run('git', [...gitPrefix, ...args], { cwd: options.cwd, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 })).stdout.trim() }
    catch { fail('NIGHT_GIT_FAILED') }
  }
  const connected = io.connect ?? (async () => { const client = await DshBridgeClient.discover(); await client.connect(); return client })
  const deps = {
    now, sleep, load: name => record(join(options.stateDir, name)),
    save: createStateWriter(join(options.stateDir, 'status.json')),
    writeStop: async value => {
      const file = join(options.stateDir, 'stop-admission.json')
      try { await writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      return record(file)
    },
    async readLimits() {
      const client = io.codexFactory ? io.codexFactory() : new CodexAppServerClient(options.codexCommand ?? 'codex')
      try { await client.initialize(); return await client.rpc('account/rateLimits/read', {}, 30000) }
      finally { client.close() }
    },
    async notify(auth, trigger) {
      const client = await connected()
      const text = `[Codex 协作回复 / mailbox ${auth.runId}-closeout]\n本夜 Codex 五小时额度已确认耗尽，停止接新任务并完成在途写入。主人已授权收尾和关机。请核对 ${options.stateDir} 下的 stop-admission.json 和 docs/NIGHT_CLOSEOUT.md；完成审查、测试、提交后写 reviewed-commit.json，再写本次 runId 的 tasks-complete.json。不要让未知草稿自动提交。脚本将依次完成百度网盘同步、已签收 commit 的推送和非强制关机。无需回复握手；只在确有阻塞时报告。`
      // The same durable request ID is reused if an acknowledgement is lost.
      for (const id of auth.sessionIds) await client.send(id, text, `${auth.runId}-closeout-${trigger.triggeredAtMs}`, { mode: 'steer' })
    },
    async reportBlocked(auth, state) {
      const client = await connected()
      const text = `[Codex 协作回复 / mailbox ${auth.runId}-closeout-blocked]\n自动收尾停止，未请求关机。原因：${state.error}；本夜状态文件：${join(options.stateDir, 'status.json')}。请保留未签收工作并处理阻塞，不要绕过签收、云同步或推送核验。`
      await client.send(auth.sessionIds[0], text, `${auth.runId}-blocked-${state.triggeredAtMs ?? state.startedAtMs}-${state.error}`, { mode: 'steer' })
    },
    async idle(auth) {
      const client = await connected()
      const { items } = await client.list()
      return auth.sessionIds.every(id => items?.some(item => item.sessionId === id && item.running === false
        && item.projections?.kind === 'sequenced' && Array.isArray(item.projections.values?.inbox?.['next-turn'])
        && Array.isArray(item.projections.values?.inbox?.['next-step'])
        && item.projections.values.inbox['next-turn'].length === 0 && item.projections.values.inbox['next-step'].length === 0))
    },
    async inspectGit() {
      const cwd = await realpath(await git(['rev-parse', '--show-toplevel']))
      if (!samePath(cwd, await realpath(options.cwd))) fail('NIGHT_WRONG_WORKTREE')
      const remote = await git(['remote', 'get-url', '--push', 'origin'])
      if (![REPOSITORY, 'https://github.com/liz-201/dsh-companion-memory', 'git@github.com:liz-201/dsh-companion-memory.git'].includes(remote)) fail('NIGHT_WRONG_REMOTE')
      return { commit: await git(['rev-parse', 'HEAD']), dirty: !!await git(['status', '--porcelain=v1', '--untracked-files=all']) }
    },
    verifyEvidence,
    async syncCloud() {
      const client = await connected()
      const get = (path, init = {}) => request(new URL(path, client.url), {
        ...init, redirect: 'error', signal: AbortSignal.timeout(55000), headers: { cookie: client.cookie, ...init.headers },
      })
      const html = await (await get('/companion-memory/manage')).text()
      const match = /const token=("[^"\n]+")/.exec(html)
      if (!match) fail('NIGHT_CONTROL_TOKEN_MISSING')
      const headers = { 'x-companion-token': JSON.parse(match[1]), 'content-type': 'application/json' }
      const startedAtMs = now()
      const exported = await get('/companion-memory/api/export', { method: 'POST', headers, body: '{}' })
      if (!exported.ok || (await exported.json()).upload !== 'queued') fail('NIGHT_AUTO_UPLOAD_DISABLED')
      // A transport timeout has an unknown outcome; status polling must resolve it.
      try { await get('/companion-memory/api/sync', { method: 'POST', headers, body: '{}' }) } catch {}
      const until = startedAtMs + (options.cloudTimeoutMs ?? 300000)
      while (now() < until) {
        const response = await get('/companion-memory/api/status', { headers })
        if (!response.ok) fail('NIGHT_CLOUD_STATUS_FAILED')
        const status = await response.json()
        if (status.enabled !== true || status.connected !== true) fail('NIGHT_CLOUD_DISCONNECTED')
        if (!status.busy && status.error) fail('NIGHT_CLOUD_SYNC_FAILED')
        if (status.busy === false && status.ready === true && status.error === null && Number.isSafeInteger(status.lastSyncAtMs)
          && status.lastSyncAtMs >= startedAtMs && status.lastSyncAtMs <= now() + 1000) {
          return { startedAtMs, lastSyncAtMs: status.lastSyncAtMs, uploadQueued: true, notice: !!status.notice,
            evidence: 'MemoryTransfer.runSync verifies upload metadata and downloaded SHA256 before marking success; unchanged snapshots reuse the previously verified upload fingerprint.' }
        }
        await sleep(2000)
      }
      fail('NIGHT_CLOUD_SYNC_TIMEOUT')
    },
    async push(commit) {
      // Fetch and ancestry check prevent replacing a newer or unrelated main.
      await git(['fetch', '--no-tags', 'origin', 'main'])
      await git(['merge-base', '--is-ancestor', 'FETCH_HEAD', commit])
      await git(['push', 'origin', `${commit}:refs/heads/main`])
      return deps.remoteHead()
    },
    async remoteHead() {
      const value = await git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main'])
      return value.split(/\s+/)[0]
    },
    async shutdown() {
      if ((io.platform ?? process.platform) !== 'win32') fail('NIGHT_WINDOWS_REQUIRED')
      // /t > 0 implicitly enables /f on Windows. The cancellable delay is in this script.
      try { await run('shutdown.exe', ['/s', '/t', '0'], { windowsHide: true, timeout: 15000 }) }
      catch { fail('NIGHT_SHUTDOWN_FAILED') }
    },
  }
  return deps
}

/** Cooperative signoff is required; this process never kills editors or commits their changes. */
export async function runNightCloseout(options, deps = createLiveDependencies(options)) {
  if (!/^[\w.-]{1,100}$/.test(options.runId ?? '') || !options.cwd || !options.stateDir) fail('NIGHT_OPTIONS_INVALID')
  const execute = options.execute === true && options.checkOnce !== true
  let auth = validateAuthorization(await deps.load('authorization.json'), options, deps.now())
  const state = { version: 1, runId: options.runId, startedAtMs: deps.now(), execute, phase: 'checking-quota' }
  const save = async phase => { state.phase = phase; state.updatedAtMs = deps.now(); if (execute) await deps.save({ ...state }) }
  const ensureAuthorized = async () => {
    auth = validateAuthorization(await deps.load('authorization.json'), options, deps.now())
    let cancelled
    try { cancelled = await deps.load('cancel-closeout.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (cancelled?.runId === options.runId) fail('NIGHT_CANCELLED')
  }
  const check = async trigger => {
    await ensureAuthorized()
    const manifest = await deps.load('reviewed-commit.json'), complete = await deps.load('tasks-complete.json')
    const commit = validateSignoff(manifest, complete, auth, trigger, deps.now())
    await deps.verifyEvidence(options.cwd, manifest.tests.evidence)
    const git = await deps.inspectGit()
    if (git.dirty) fail('NIGHT_DIRTY_WORKTREE')
    if (git.commit !== commit) fail('NIGHT_UNREVIEWED_HEAD')
    if (!await deps.idle(auth)) fail('NIGHT_TASKS_ACTIVE')
    return commit
  }
  try {
    try {
      const prior = await deps.load('status.json')
      if (prior.runId === options.runId && prior.phase === 'shutdown-requested') return { ...prior, phase: 'already-requested' }
      if (prior.runId === options.runId && (prior.phase === 'shutdown-requesting' || prior.error === 'NIGHT_SHUTDOWN_FAILED')) {
        return { ...prior, phase: 'blocked', error: 'NIGHT_SHUTDOWN_OUTCOME_UNKNOWN' }
      }
    } catch {}
    let trigger
    // A confirmed, same-run stop survives an interrupted closeout, but not another night's authorization.
    try {
      const prior = await deps.load('stop-admission.json')
      if (prior.version === 1 && prior.runId === options.runId && clock(prior.triggeredAtMs) && prior.triggeredAtMs >= auth.authorizedAtMs
        && prior.triggeredAtMs <= deps.now() && fiveHourLimit({ rateLimits: { primary: prior.quota } }, prior.triggeredAtMs)) trigger = prior
    } catch {}
    do {
      await ensureAuthorized()
      if (!trigger) {
        try {
          const quota = fiveHourLimit(await deps.readLimits(), deps.now())
          delete state.error
          if (quota) trigger = { version: 1, runId: options.runId, triggeredAtMs: deps.now(), reason: 'five-hour-quota-exhausted', quota }
        } catch { state.error = 'NIGHT_QUOTA_UNAVAILABLE'; await save('quota-unavailable') }
      }
      if (!execute) {
        state.quotaExhausted = !!trigger
        if (trigger) { try { state.reviewedCommit = await check(trigger); state.signoffReady = true } catch (error) { state.blockedBy = safeFailure(error) } }
        state.phase = 'dry-run'; return state
      }
      if (!trigger) { await save('monitoring'); await deps.sleep(Math.min(options.pollMs ?? 60000, 60000)) }
    } while (!trigger)
    delete state.error
    const persisted = await deps.writeStop(trigger)
    if (persisted.runId !== trigger.runId || persisted.triggeredAtMs !== trigger.triggeredAtMs) fail('NIGHT_STOP_CONFLICT')
    state.triggeredAtMs = trigger.triggeredAtMs
    await save('admission-stopped')
    await deps.notify(auth, trigger)
    const until = deps.now() + (options.completionTimeoutMs ?? 1800000)
    let commit
    while (!commit && deps.now() < until) {
      await ensureAuthorized()
      try { commit = await check(trigger) }
      catch (error) { state.blockedBy = safeFailure(error); await save('waiting-for-signoff'); await deps.sleep(Math.min(options.signoffPollMs ?? 10000, 60000)) }
    }
    if (!commit) fail('NIGHT_SIGNOFF_TIMEOUT')
    state.reviewedCommit = commit; delete state.blockedBy
    await save('syncing-memory')
    state.cloud = await deps.syncCloud()
    if (await check(trigger) !== commit) fail('NIGHT_SIGNOFF_CHANGED')
    await save('pushing-reviewed-commit')
    if (await deps.push(commit) !== commit) fail('NIGHT_REMOTE_NOT_CONFIRMED')
    if (await check(trigger) !== commit) fail('NIGHT_SIGNOFF_CHANGED')
    if (await deps.remoteHead() !== commit) fail('NIGHT_REMOTE_NOT_CONFIRMED')
    await save('shutdown-countdown')
    const shutdownAt = deps.now() + (options.shutdownDelayMs ?? 60000)
    while (deps.now() < shutdownAt) {
      await deps.sleep(Math.min(1000, shutdownAt - deps.now()))
      await ensureAuthorized()
    }
    if (await check(trigger) !== commit) fail('NIGHT_SIGNOFF_CHANGED')
    // The push/countdown can overlap already-admitted consolidation or a peer upload.
    // Flush memory once more before the final operating-system request.
    state.finalCloud = await deps.syncCloud()
    if (await check(trigger) !== commit) fail('NIGHT_SIGNOFF_CHANGED')
    if (await deps.remoteHead() !== commit) fail('NIGHT_REMOTE_NOT_CONFIRMED')
    await ensureAuthorized()
    await save('shutdown-requesting')
    await deps.shutdown()
    await save('shutdown-requested')
  } catch (error) {
    state.error = safeFailure(error)
    try { await save('blocked') } catch { state.phase = 'blocked' }
    if (execute && deps.reportBlocked) { try { await deps.reportBlocked(auth, state) } catch {} }
  }
  return state
}

async function main() {
  const { values } = parseArgs({ options: {
    'run-id': { type: 'string' }, cwd: { type: 'string' }, 'state-dir': { type: 'string' },
    execute: { type: 'boolean', default: false }, 'check-once': { type: 'boolean', default: false },
    codex: { type: 'string' }, 'poll-ms': { type: 'string' }, 'git-proxy': { type: 'string' },
  } })
  if (!values['run-id'] || !values.cwd || !values['state-dir']) fail('NIGHT_OPTIONS_INVALID')
  const options = { runId: values['run-id'], cwd: resolve(values.cwd), stateDir: resolve(values['state-dir']),
    execute: values.execute, checkOnce: values['check-once'], codexCommand: values.codex, gitProxy: values['git-proxy'], pollMs: Number(values['poll-ms'] ?? 60000) }
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1000 || options.pollMs > 60000) fail('NIGHT_OPTIONS_INVALID')
  let lock
  try {
    if (options.execute && !options.checkOnce) {
      await mkdir(options.stateDir, { recursive: true, mode: 0o700 })
      lock = await open(join(options.stateDir, 'closeout.lock'), 'wx', 0o600)
      await lock.writeFile(JSON.stringify({ pid: process.pid, runId: options.runId }))
    }
    const state = await runNightCloseout(options)
    console.log(JSON.stringify(state, null, 2))
    if (state.phase === 'blocked') process.exitCode = 1
  } finally { if (lock) { await lock.close(); await unlink(join(options.stateDir, 'closeout.lock')) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Night closeout could not start; no shutdown was requested.'); process.exitCode = 1 })
}
