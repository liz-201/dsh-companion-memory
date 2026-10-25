import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-codex-bridge'
export const inject = ['connection', 'webServer']

export function publishConnection(ctx, directory = join(homedir(), '.dsh', 'codex-bridge')) {
  // The current Desktop webServer exposes getOrigin(), not an origin property.
  const origin = typeof ctx.webServer.getOrigin === 'function' ? ctx.webServer.getOrigin() : ctx.webServer.origin
  if (typeof origin !== 'string' || !origin) throw new Error('Desktop web listener origin is not ready')
  const base = new URL(origin)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password) {
    throw new Error('codex bridge requires the IPv4 loopback Desktop listener')
  }
  const url = new URL(ctx.connection.authenticatedUrl(base.href))
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !url.searchParams.get('token')) {
    throw new Error('codex bridge requires the authenticated IPv4 loopback Desktop endpoint')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const generation = randomUUID()
  const file = join(directory, 'connection.json')
  const temporary = join(directory, `${generation}.tmp`)
  const connection = { version: 1, generation, pid: process.pid, publishedAt: new Date().toISOString(), url: url.href }
  writeFileSync(temporary, JSON.stringify(connection), { mode: 0o600, flag: 'wx' })
  try { renameSync(temporary, file) } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).generation === generation) unlinkSync(file)
    } catch { /* Already removed, replaced, or inaccessible during host teardown. */ }
  }
}

export function mountConnectionDiscovery(ctx, directory) {
  // Desktop exposes the readiness of its listener through appReady, rather
  // than a promise on webServer. Mirror the host gateway's startup ordering.
  const ready = ctx.get?.('appReady')
  return ctx.effect(() => {
    let closed = false
    let release
    const publish = () => {
      if (closed) return
      try {
        const previous = release
        release = publishConnection(ctx, directory)
        previous?.()
      } catch {
        // Optional discovery must never abort appReady.commit() or reveal launch credentials.
        console.warn('[codex-bridge] Local connection discovery failed; Desktop startup will continue. Check listener readiness and discovery directory permissions.')
      }
    }
    const cancel = ready === undefined ? (publish(), () => {}) : ready.onReady(publish)
    return () => { closed = true; cancel(); release?.() }
  }, 'codex-bridge: local connection discovery')
}

export function apply(ctx) { mountConnectionDiscovery(ctx) }
