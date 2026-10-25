import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

interface EntryContext {
  on?(event: string, listener: (...args: unknown[]) => unknown): unknown
  get?(name: string): unknown
}
/** The host renders this same injection table in both Web and Electron Desktop. */
export function mountPanelEntry(ctx: EntryContext, directory: string, getOrigin: () => string): () => void {
  const generation = randomUUID(), file = join(directory, 'control-panel.json')
  let closed = false
  const publish = (): string | null => {
    if (closed) return null
    try {
      const origin = new URL(getOrigin())
      if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password) return null
      const url = new URL('/companion-memory/manage', origin).href
      mkdirSync(directory, { recursive: true })
      writeFileSync(file, JSON.stringify({ generation, pid: process.pid, url }), { mode: 0o600 })
      return url
    } catch { return null }
  }
  const listener = (table: unknown): void => {
    if (!Array.isArray(table)) return
    const url = publish()
    if (!url) return
    table.push({ kind: 'html', placement: 'body', html: `<a id="companion-panel-entry" href="${url}" target="_blank" rel="noopener noreferrer" title="打开情感记忆插件控制台" style="position:fixed;right:20px;bottom:76px;z-index:2147483000;background:#245fca;color:white;padding:10px 15px;border-radius:12px;text-decoration:none;font:14px system-ui;box-shadow:0 3px 16px #163e7140">🐟 插件控制台</a>` })
  }
  const unlisten = ctx.on?.('webserver/index-inject', listener)
  const ready = ctx.get?.('appReady') as { onReady?: (callback: () => void) => (() => void) } | undefined
  const cancelReady = ready?.onReady?.(() => { publish() })
  publish()
  return () => {
    closed = true
    if (typeof unlisten === 'function') unlisten()
    cancelReady?.()
    try { if (JSON.parse(readFileSync(file, 'utf8')).generation === generation) unlinkSync(file) } catch {}
  }
}
