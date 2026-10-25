import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

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

export function mailboxInstructions() {
  const script = fileURLToPath(new URL('../../scripts/codex-mailbox.mjs', import.meta.url))
  const command = `node '${script.replaceAll("'", "''")}'`
  return `本机已安装 Codex 双向协作收件箱。仅在用户授权的开发协作中使用，不发送凭据或无关私人对话。
你可以主动给 Codex 投递请求，无需用户手工转述：先将内容写入 UTF-8 文件，再用 PowerShell 执行 ${command} send --session <当前真实DSH会话ID> --file <文件绝对路径> --id <本次稳定消息ID>。
执行同一脚本的 status 查看消费者；read --id <消息ID> 查看回执和回复。回复会以 [Codex 协作回复 / mailbox ...] 排队返回原 DSH 会话。只在内容完全相同时重用消息ID，避免反复催问。
pending=已保存待领取，claimed=已领取，response-ready=回复已保存待投递，response-queued=DSH已接受回复、未必已执行。polling只表示消费者最近轮询；offline时消息仍会保存，但此脚本不能唤醒已经结束的 ChatGPT/Codex 会话。不要把投递当成完成。PowerShell中文管道可能转码，优先使用UTF-8文件。`
}

export function mountMailboxInstructions(ctx) {
  const register = child => {
    const prompt = child.get?.('systemPrompt')
    if (typeof prompt?.context !== 'function') return
    const release = prompt.context({ name: 'codex-bridge:mailbox', order: 520, required: false, interpolate: false, text: mailboxInstructions })
    if (typeof release === 'function') child.effect(() => release, 'codex-bridge: mailbox instructions')
  }
  if (typeof ctx.inject === 'function') {
    const fiber = ctx.inject(['systemPrompt'], register)
    ctx.effect(() => () => { void fiber.dispose() }, 'codex-bridge: optional system prompt')
  } else register(ctx)
}

export function apply(ctx) {
  mountConnectionDiscovery(ctx)
  mountMailboxInstructions(ctx)
}
