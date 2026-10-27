import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createStateWriter } from '../../scripts/codex-worker-state.mjs'

async function fixture(t) {
  const temporaryBase = await realpath(tmpdir())
  const directory = await mkdtemp(join(temporaryBase, 'codex-worker-state-'))
  const file = join(directory, 'worker.json')
  t.after(async () => {
    const target = resolve(directory)
    assert.equal(dirname(target), temporaryBase)
    assert.match(basename(target), /^codex-worker-state-[a-z\d]+$/iu)
    await rm(target, { recursive: true, force: true })
  })
  await writeFile(file, JSON.stringify({ state: 'old' }))
  return { directory, file }
}

const failure = code => Object.assign(new Error(`simulated ${code}`), { code })

test('state writes are serialized and capture JSON when called rather than when dequeued', async t => {
  const { directory, file } = await fixture(t)
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const firstRename = new Promise(resolve => { started = resolve })
  const snapshots = [], opens = []
  const write = createStateWriter(file, {
    async open(path, flags, mode) { opens.push({ path, flags, mode }); return open(path, flags, mode) },
    async rename(from, to) {
      snapshots.push(JSON.parse(await readFile(from, 'utf8')))
      if (snapshots.length === 1) { started(); await gate }
      await rename(from, to)
    },
  })
  const state = { activeTasks: [{ stage: 'first' }] }
  const first = write(state)
  state.activeTasks[0].stage = 'second'
  const second = write(state)
  state.activeTasks[0].stage = 'mutated-later'
  let flushed = false
  const flushing = write.flush().then(() => { flushed = true })
  await firstRename
  assert.equal(snapshots.length, 1)
  assert.equal(opens.length, 1)
  assert.equal(flushed, false)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'old' })
  release()
  await Promise.all([first, second, flushing])
  assert.deepEqual(snapshots, [{ activeTasks: [{ stage: 'first' }] }, { activeTasks: [{ stage: 'second' }] }])
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), snapshots[1])
  assert.equal(flushed, true)
  assert.ok(opens.every(entry => dirname(entry.path) === directory && entry.flags === 'wx' && entry.mode === 0o600))
  assert.equal(new Set(opens.map(entry => entry.path)).size, 2)
  assert.deepEqual(await readdir(directory), ['worker.json'])
})

test('temporary Windows rename locks retry asynchronously before an atomic replacement', async t => {
  const { file, directory } = await fixture(t)
  const codes = ['EPERM', 'EACCES', 'EBUSY'], sleeps = [], removals = []
  let elapsed = 0, attempts = 0
  const write = createStateWriter(file, {
    now: () => elapsed,
    async sleep(ms) { sleeps.push(ms); elapsed += ms },
    async unlink(path) { removals.push(path); await unlink(path) },
    async rename(from, to) {
      if (attempts++ < codes.length) {
        assert.deepEqual(JSON.parse(await readFile(to, 'utf8')), { state: 'old' })
        throw failure(codes[attempts - 1])
      }
      await rename(from, to)
    },
  })
  await write({ state: 'new' })
  await write.flush()
  assert.equal(attempts, 4)
  assert.deepEqual(sleeps, [10, 20, 40])
  assert.deepEqual(removals, [])
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'new' })
  assert.deepEqual(await readdir(directory), ['worker.json'])
})

test('persistent rename locks stop after two seconds and clean only their temporary file', async t => {
  const { file, directory } = await fixture(t)
  let elapsed = 0, attempts = 0
  const removals = [], error = failure('EPERM')
  const write = createStateWriter(file, {
    now: () => elapsed,
    async sleep(ms) { elapsed += ms },
    async rename() { attempts++; throw error },
    async unlink(path) { removals.push(path); assert.notEqual(path, file); await unlink(path) },
  })
  await assert.rejects(write({ state: 'cannot-replace' }), caught => caught === error)
  await assert.rejects(write.flush(), caught => caught === error)
  assert.equal(elapsed, 2000)
  assert.ok(attempts > 1)
  assert.equal(removals.length, 1)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'old' })
  assert.deepEqual(await readdir(directory), ['worker.json'])
})

test('nontransient errors propagate without retry while subsequent queued writes can still succeed', async t => {
  const { file, directory } = await fixture(t)
  let attempts = 0, sleeps = 0
  const error = failure('EIO')
  const write = createStateWriter(file, {
    async sleep() { sleeps++ },
    async rename(from, to) { if (++attempts === 1) throw error; await rename(from, to) },
  })
  const first = assert.rejects(write({ state: 'failed' }), caught => caught === error)
  const second = write({ state: 'recovered' })
  await Promise.all([first, second])
  await assert.rejects(write.flush(), caught => caught === error)
  assert.equal(attempts, 2)
  assert.equal(sleeps, 0)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'recovered' })
  assert.deepEqual(await readdir(directory), ['worker.json'])
})

test('failed temporary writes close and remove the temporary without touching existing target data', async t => {
  const { file, directory } = await fixture(t)
  let closed = false, renamed = false
  const error = failure('ENOSPC')
  const write = createStateWriter(file, {
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode)
      return {
        async writeFile() { throw error },
        async close() { closed = true; await handle.close() },
      }
    },
    async rename() { renamed = true },
  })
  await assert.rejects(write({ state: 'new' }), caught => caught === error)
  assert.equal(closed, true)
  assert.equal(renamed, false)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'old' })
  assert.deepEqual(await readdir(directory), ['worker.json'])
})

test('serialization failures reject as promises and flush only waits for calls already queued', async t => {
  const { file } = await fixture(t)
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const began = new Promise(resolve => { started = resolve })
  const write = createStateWriter(file, {
    async mkdir(...args) { started(); await gate; return mkdir(...args) },
  })
  const valid = write({ state: 'valid' })
  const earlierFlush = write.flush()
  const circular = {}; circular.self = circular
  const invalid = assert.rejects(write(circular), /circular/iu)
  await began
  release()
  await Promise.all([valid, earlierFlush, invalid])
  await assert.rejects(write.flush(), /circular/iu)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'valid' })
})
