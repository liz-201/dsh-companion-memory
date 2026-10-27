import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

/** Serialize atomic state updates, retrying only transient Windows rename locks. */
export function createStateWriter(file, deps = {}) {
  const target = resolve(file)
  const directory = dirname(target)
  const io = { mkdir, open, rename, unlink, now: () => performance.now(), sleep: delay, ...deps }
  let tail = Promise.resolve(), sequence = 0, firstFailure

  async function persist(content) {
    await io.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`)
    let ownsTemporary = false
    try {
      const handle = await io.open(temporary, 'wx', 0o600)
      ownsTemporary = true
      try { await handle.writeFile(content, 'utf8') }
      finally { await handle.close() }
      const startedAt = io.now()
      let retries = 0
      while (true) {
        try {
          await io.rename(temporary, target)
          ownsTemporary = false
          return
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
          const remainingMs = 2000 - (io.now() - startedAt)
          if (remainingMs <= 0) throw error
          await io.sleep(Math.min(10 * 2 ** Math.min(retries++, 4), 100, remainingMs))
        }
      }
    } finally {
      if (ownsTemporary) {
        try { await io.unlink(temporary) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
  }

  function write(value) {
    const ordinal = ++sequence
    let content, serializationError
    try {
      content = JSON.stringify(value, null, 2)
      if (content === undefined) throw new TypeError('Worker state must be JSON serializable')
    } catch (error) { serializationError = error }
    const pending = tail.then(() => {
      if (serializationError) throw serializationError
      return persist(content)
    })
    tail = pending.then(() => undefined, error => { firstFailure ??= { ordinal, error } })
    return pending
  }

  write.flush = async () => {
    const through = sequence, pending = tail
    await pending
    if (firstFailure && firstFailure.ordinal <= through) throw firstFailure.error
  }
  return write
}
