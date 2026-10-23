/**
 * QQ 发送通道（任务书 §13.2、§14.4）。
 *
 * 这里只做一件事：把一段文本按 OneBot 11 协议发给指定会话，并如实返回回执。
 * 三条硬规矩：
 *   · 平台明确拒绝（HTTP 非 2xx、retcode 非 0）→ rejected，可分类重试；
 *   · 超时 / 连接中断 → unknown（消息可能已经到了），**绝不自动重发**；
 *   · 回执里的 platformMessageId 只用于对账，不当作远端幂等键（§14.4）。
 *
 * 会话映射复用 dsh-onebot-qq 的 `chat-sessions.json`（chatId → sessionId），
 * 这样主动消息和对应用户的 Agent 会话是同一条线，不另起第二个入站消费者。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { DeliveryReceipt } from '../domain/types.js'

export interface ChatTarget {
  kind: 'private' | 'group'
  id: string
}

/**
 * 只声明本项目真正用到的那一小块 HTTP 能力。
 *
 * 不直接用全局 etch 的类型：宿主注入的类型库里 undici-types 未必在场，
 * 缺了它全局 Response 会退化成空接口，
esponse.ok / 
esponse.text()
 * 就编译不过。这里按结构声明，注入任意兼容实现即可（测试里直接塞桩）。
 */
export interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

export interface FetchInitLike {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>

export interface QqTransportOptions {
  httpBase: string
  accessToken?: string
  /** 单次请求超时；超时一律判 unknown，不重发。 */
  timeoutMs?: number
  /** 单条消息最大字符数，超出按段落切开分次发送。 */
  maxChars?: number
  fetchImpl?: FetchLike
}

export interface QqHealth {
  ok: boolean
  detail: string
  selfId: string | null
}

/** 把 `private:123` / `group:456` 拆成 OneBot 需要的参数。 */
export function parseTarget(chatId: string): ChatTarget | null {
  const match = /^(private|group):(.+)$/.exec(chatId.trim())
  if (match === null) return null
  const kind = match[1] === 'group' ? 'group' : 'private'
  const id = match[2] ?? ''
  if (!/^\d+$/.test(id)) return null
  return { kind, id }
}

/** 读 chat-sessions.json；坏文件当空映射，不让装配因为读配置而崩。 */
export function readChatSessions(file: string): Record<string, string> {
  if (file.length === 0 || !existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [chatId, sessionId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessionId === 'string' && sessionId.length > 0) out[chatId] = sessionId
    }
    return out
  } catch {
    return {}
  }
}

/** 反查：某个 Agent 会话对应哪个 chat（主动消息要发回原会话）。 */
export function chatForSession(file: string, sessionId: string): string | null {
  if (sessionId.length === 0) return null
  const map = readChatSessions(file)
  for (const [chatId, sid] of Object.entries(map)) {
    if (sid === sessionId) return chatId
  }
  return null
}

/** 长文本按段落切；不切断句子是发送层的事，这里只保证单条不超限。 */
export function splitMessage(text: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars)
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    const slice = rest.slice(0, limit)
    const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'))
    const take = cut > limit * 0.5 ? cut + 1 : limit
    parts.push(rest.slice(0, take).trim())
    rest = rest.slice(take).trim()
  }
  if (rest.length > 0) parts.push(rest)
  return parts.filter(part => part.length > 0)
}

export class QqTransport {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly maxChars: number
  private readonly fetchImpl: FetchLike
  private lastError: string | null = null

  constructor(options: QqTransportOptions) {
    this.base = options.httpBase.replace(/\/+$/, '')
    this.token = options.accessToken ?? ''
    this.timeoutMs = options.timeoutMs ?? 8000
    this.maxChars = options.maxChars ?? 1200
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike)
  }

  /** 是否配了可用的 HTTP 端点。 */
  get configured(): boolean {
    return /^https?:\/\//.test(this.base)
  }

  get lastFailure(): string | null {
    return this.lastError
  }

  /** 发一段文本。返回的回执是「平台到底怎么说」，不是「我们试过了」。 */
  async sendText(chatId: string, text: string): Promise<DeliveryReceipt> {
    const at = (): number => Date.now()
    const target = parseTarget(chatId)
    if (target === null) {
      return { kind: 'rejected', code: 'BAD_CHAT_ID', atMs: at() }
    }
    if (!this.configured) {
      return { kind: 'rejected', code: 'NO_ENDPOINT', atMs: at() }
    }
    const chunks = splitMessage(text, this.maxChars)
    let last: DeliveryReceipt = { kind: 'unknown', atMs: at() }
    for (const chunk of chunks) {
      last = await this.sendChunk(target, chunk)
      if (last.kind !== 'accepted') return last
    }
    return last
  }

  private async sendChunk(target: ChatTarget, text: string): Promise<DeliveryReceipt> {
    const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const body: Record<string, unknown> = target.kind === 'group'
      ? { group_id: Number(target.id), message: [{ type: 'text', data: { text } }], auto_escape: false }
      : { user_id: Number(target.id), message: [{ type: 'text', data: { text } }], auto_escape: false }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.base}/${action}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await response.text()
      const parsed = safeJson(raw)
      const atMs = Date.now()
      if (!response.ok) {
        this.lastError = `${action} HTTP ${response.status}`
        return { kind: 'rejected', code: `HTTP_${response.status}`, atMs }
      }
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as { status?: unknown; retcode?: unknown; message?: unknown; data?: unknown }
        if (typeof record.retcode !== 'number' || typeof record.status !== 'string') return { kind: 'unknown', code: 'INVALID_RESPONSE', atMs }
        const retcode = record.retcode
        if (record.status === 'failed' || retcode !== 0) {
          const code = typeof record.message === 'string' ? record.message.slice(0, 60) : `RETCODE_${retcode}`
          this.lastError = `${action} failed: ${code}`
          return { kind: 'rejected', code, atMs }
        }
        const data = record.data
        const messageId = data !== null && typeof data === 'object'
          ? (data as { message_id?: unknown }).message_id
          : undefined
        return {
          kind: 'accepted',
          platformMessageId: typeof messageId === 'number' ? String(messageId) : undefined,
          atMs,
        }
      }
      // 200 但响应体不是 JSON：平台接受了请求，但没法确认消息 id。
      return { kind: 'unknown', code: 'INVALID_RESPONSE', atMs }
    } catch (error) {
      // 超时与断连都归 unknown：消息可能已经送达，重发会造成重复（§14.4）。
      this.lastError = describe(error)
      return { kind: 'unknown', code: isAbort(error) ? 'TIMEOUT' : 'NETWORK', atMs: Date.now() }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 探活：get_login_info 能回 ok 才算在线。 */
  async health(): Promise<QqHealth> {
    if (!this.configured) return { ok: false, detail: '未配置 OneBot HTTP 端点', selfId: null }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.base}/get_login_info`, {
        method: 'POST',
        headers: this.headers(),
        body: '{}',
        signal: controller.signal,
      })
      const parsed = safeJson(await response.text())
      if (!response.ok || parsed === null || typeof parsed !== 'object') {
        return { ok: false, detail: `get_login_info HTTP ${response.status}`, selfId: null }
      }
      const record = parsed as { status?: unknown; data?: unknown }
      const data = record.data !== null && typeof record.data === 'object'
        ? (record.data as { user_id?: unknown })
        : undefined
      const selfId = typeof data?.user_id === 'number' ? String(data.user_id) : null
      return { ok: record.status === 'ok', detail: record.status === 'ok' ? '已登录' : '未登录', selfId }
    } catch (error) {
      return { ok: false, detail: describe(error), selfId: null }
    } finally {
      clearTimeout(timer)
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token.length > 0) headers['authorization'] = `Bearer ${this.token}`
    return headers
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
