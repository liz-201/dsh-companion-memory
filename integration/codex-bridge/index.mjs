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
  const workerScript = fileURLToPath(new URL('../../scripts/codex-mailbox-worker.mjs', import.meta.url))
  const workerCommand = `node '${workerScript.replaceAll("'", "''")}'`
  return `本机已安装 Codex 双向协作收件箱，0.3.0 支持一个接收器内的独立任务线程。仅在用户授权的开发协作中使用，不发送凭据或无关私人对话。
你可以主动给 Codex 投递请求：先将内容写入 UTF-8 文件，再用 PowerShell 执行 ${command} send --session <当前真实DSH会话ID> --kind <chat|review|write> --file <文件绝对路径> --id <本次稳定消息ID>。
必须按实际意图选 kind：chat 用于只读的简短沟通或进度问题；review 使用当前文件的独立快照，可在副本内构建测试，不自动合入主仓库；write 才用于修改主仓库，省略 --kind 时默认为 write。不要把需要修改主仓库的任务伪装成 chat 或 review。
接收器 --concurrency 默认 3，范围 1..4；有多个名额时保留一个 chat 位置，write 在主仓库全局互斥，多个 review 在各自副本中运行。不要为催进度重复发送 write；请另发 chat 查询。
执行同一脚本的 status 查看消费者；执行 ${workerCommand} status 查看 worker.json 中 activeTasks 的全部任务、线程、轮次和 stage，兼容字段 active 只代表首项。read --id <消息ID> 查看回执和回复。回复会以 [Codex 协作回复 / mailbox ...] 送回原 DSH 会话；只在会话、kind 和正文都完全相同时重用消息ID。
review 回执中的快照 manifest 标识具体输入；副本中的测试通过不等于当前主仓库已通过，后续文件修改也不包含在旧快照内。write 若无法确认已经终止，会隔离后续 write；chat 仍可沟通，不能通过另发 write 绕过隔离。stop 或截止会中断全部活动轮次，等待收尾后退出。
收件箱 schema 1 会自动升级为 2，保留旧消息，旧消息 kind 默认为 write，无需手动迁移或重复发信。
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
