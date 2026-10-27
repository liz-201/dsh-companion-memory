import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { CodexAppServerClient } from '../../scripts/codex-app-server-client.mjs'
import { CodexMailbox } from '../../scripts/codex-mailbox-store.mjs'
import { runMailboxWorker } from '../../scripts/codex-mailbox-worker.mjs'

function protocol(t, mode) {
  const client = new CodexAppServerClient(process.execPath, [resolve('tests/fixtures/codex-app-server.mjs'), mode])
  t.after(() => client.close())
  return client
}

test('chat thread explicitly selects read-only sandbox and removes inherited extra write roots', async t => {
  const client = protocol(t, 'read-only')
  await client.initialize()
  assert.equal(await client.startThread(process.cwd(), 'chat', { readOnly: true }), 'thread-fixture')
})

for (const mode of ['initialize-hang', 'thread-hang']) test(`stop aborts ${mode} metadata admission without waiting for its transport timeout`, async t => {
  const client = protocol(t, mode)
  const controller = new AbortController()
  if (mode === 'thread-hang') await client.initialize()
  const pending = mode === 'initialize-hang' ? client.initialize({ signal: controller.signal })
    : client.startThread(process.cwd(), 'fixture', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /CODEX_RPC_ABORTED/)
  assert.equal(client.pending.size, 0)
})

test('absolute task budget includes an unacknowledged turn admission and reports its uncertain outcome', async t => {
  const client = protocol(t, 'admission-hang')
  await client.initialize()
  const threadId = await client.startThread(process.cwd(), 'fixture')
  await assert.rejects(client.run(threadId, 'fixture', { hardTimeoutMs: 80 }), error =>
    error.message === 'CODEX_TURN_TIMEOUT' && error.terminal === false)
  assert.equal(client.pending.size, 0)
})

test('pre-aborted turns are known not to have started', async t => {
  const client = protocol(t, 'normal')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(client.run('unused', 'fixture', { signal: controller.signal }), error =>
    error.terminal === true && error.message === 'CODEX_TURN_INTERRUPTED')
  assert.equal(client.pending.size, 0)
})

test('stop while starting a thread never admits a turn or quarantines later writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-admission-'))
  const mailboxFile = join(dir, 'box.sqlite3'), stateFile = join(dir, 'worker.json')
  const box = new CodexMailbox(mailboxFile)
  t.after(() => { box.close(); rmSync(dir, { recursive: true, force: true }) })
  box.enqueue({ sessionId: 'session-allowed', text: 'fixture', id: 'one' })
  const state = await runMailboxWorker({ mailboxFile, stateFile, sessionIds: ['session-allowed'],
    untilMs: Date.now() + 10000, pollMs: 5, maxTasks: 1,
    clientFactory: () => ({
      async initialize() {},
      async startThread(_cwd, _instructions, { signal }) {
        const current = JSON.parse(readFileSync(stateFile, 'utf8'))
        writeFileSync(`${stateFile}.stop`, JSON.stringify({ generation: current.generation }))
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        return 'thread-never-used'
      },
      async run() { assert.fail('A stopped request must never admit a turn') },
      close() {},
    }), dshFactory: async () => ({ send: async () => {} }),
  })
  assert.equal(state.state, 'stopped')
  assert.equal(state.quarantine, null)
  assert.equal(state.lastFailure.terminal, true)
  assert.equal(box.read('one').state, 'response-queued')
})

test('default review client prevents snapshot Git from discovering the parent source repository', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-review-git-'))
  execFileSync('git', ['init', '--quiet', dir])
  writeFileSync(join(dir, 'README.md'), 'source snapshot fixture')
  const mailboxFile = join(dir, 'artifacts', 'box.sqlite3'), stateFile = join(dir, 'artifacts', 'worker.json')
  const box = new CodexMailbox(mailboxFile)
  t.after(() => { box.close(); rmSync(dir, { recursive: true, force: true }) })
  const message = box.enqueue({ sessionId: 'session-allowed', kind: 'review', text: 'fixture review' })
  const state = await runMailboxWorker({ cwd: dir, mailboxFile, stateFile, sessionIds: ['session-allowed'],
    untilMs: Date.now() + 10000, pollMs: 5, maxTasks: 1, codexCommand: process.execPath,
    codexArgs: [resolve('tests/fixtures/codex-app-server.mjs'), 'review-isolation'],
    dshFactory: async () => ({ send: async () => {} }),
  })
  assert.equal(state.failures, 0)
  assert.match(box.read(message.id).response, /双向处理成功/)
})

test('corrupt worker journals fail closed without overwriting their evidence or starting a receiver', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-journal-'))
  const mailboxFile = join(dir, 'box.sqlite3'), stateFile = join(dir, 'worker.json')
  const box = new CodexMailbox(mailboxFile)
  t.after(() => { box.close(); rmSync(dir, { recursive: true, force: true }) })
  for (const content of ['{broken', '{"activeTasks":"invalid"}', '{"active":{"turnId":"unknown"}}']) {
    writeFileSync(stateFile, content)
    await assert.rejects(runMailboxWorker({ mailboxFile, stateFile, untilMs: Date.now() + 10000,
      sessionIds: ['session-allowed'], clientFactory() { assert.fail('Corrupt journals must not admit model work') },
    }), /INVALID_WORKER_JOURNAL/)
    assert.equal(readFileSync(stateFile, 'utf8'), content)
    assert.equal(box.receiver().state, 'offline')
  }
})
