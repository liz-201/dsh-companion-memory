import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BaiduCredentials, BaiduTokens } from './baidu-client.js'

/** This file stays outside transfer snapshots and is never returned through status. */
export const CONNECTION_FORMAT = 'dsh-companion-memory/connection@1'
const INVALID_FILE = '百度网盘本地授权配置无效，请在记忆管理页重新连接。'
const INVALID_INPUT = '请填写有效的应用信息与应用目录名。'
const INVALID_CONNECTION = '连接配置无效：需要包含 appKey、secretKey、appFolder。'
const INVALID_FORMAT = '连接配置版本不匹配，请重新导出。'

export interface ConnectionFields { appKey: string; secretKey: string; appFolder: string }
export interface ConnectionPayload extends ConnectionFields { format: string; tokens?: BaiduTokens }
export interface ConnectionSummary { appKey: string; appFolder: string; hasTokens: boolean; expiresAtMs: number | null }

/**
 * 应用信息与目录名的唯一校验入口：连接页、凭据文件、导入的连接配置都必须走这里，
 * 否则三处规则会各自漂移。
 */
export function validateConnectionFields(input: Record<string, unknown>, message = INVALID_INPUT): ConnectionFields {
  const appKey = typeof input['appKey'] === 'string' ? input['appKey'].trim() : ''
  const secretKey = typeof input['secretKey'] === 'string' ? input['secretKey'].trim() : ''
  const appFolder = typeof input['appFolder'] === 'string' ? input['appFolder'].trim() : ''
  if (!appKey || !secretKey || !appFolder) throw new Error(message)
  if (/[\/\\\x00-\x1f]/.test(appFolder) || ['.', '..'].includes(appFolder)) throw new Error(message)
  return { appKey, secretKey, appFolder }
}

/** 令牌只接受已知的三个字段，多余键一律丢弃，避免把任意内容写回凭据文件。 */
export function validateTokens(value: unknown, message = INVALID_CONNECTION): BaiduTokens | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  const record = value as Record<string, unknown>
  const accessToken = typeof record['accessToken'] === 'string' ? record['accessToken'].trim() : ''
  if (!accessToken) throw new Error(message)
  const tokens: BaiduTokens = { accessToken }
  const refreshToken = typeof record['refreshToken'] === 'string' ? record['refreshToken'].trim() : ''
  if (refreshToken) tokens.refreshToken = refreshToken
  const expiresAtMs = record['expiresAtMs']
  if (typeof expiresAtMs === 'number' && Number.isFinite(expiresAtMs)) tokens.expiresAtMs = expiresAtMs
  else if (expiresAtMs !== undefined && expiresAtMs !== null) throw new Error(message)
  return tokens
}

/**
 * 导出连接配置。默认不含令牌：两台机器共用同一 refreshToken 时，百度若在刷新时轮换
 * refreshToken，先刷新的一台会把另一台踢下线，所以带令牌必须是显式选择。
 */
export function serializeConnection(credentials: BaiduCredentials, options: { includeTokens?: boolean } = {}): string {
  const fields = validateConnectionFields(credentials as unknown as Record<string, unknown>)
  const payload: ConnectionPayload = { format: CONNECTION_FORMAT, ...fields }
  if (options.includeTokens) {
    const tokens = validateTokens(credentials.tokens)
    if (tokens) payload.tokens = tokens
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 解析粘贴或导入的连接配置；任何缺失都报同一句中文，避免把原始异常带到界面上。 */
export function parseConnection(text: string): BaiduCredentials {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(INVALID_CONNECTION) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_CONNECTION)
  const record = value as Record<string, unknown>
  if (record['format'] !== undefined && record['format'] !== CONNECTION_FORMAT) throw new Error(INVALID_FORMAT)
  const fields = validateConnectionFields(record, INVALID_CONNECTION)
  const tokens = validateTokens(record['tokens'])
  return tokens ? { ...fields, tokens } : fields
}

/** 给界面用的安全摘要：绝不解出完整密钥或令牌。 */
export function describeConnection(credentials: BaiduCredentials): ConnectionSummary {
  const tail = credentials.appKey.slice(-4)
  return {
    appKey: credentials.appKey.length > 8 ? `***${tail}` : '***',
    appFolder: credentials.appFolder,
    hasTokens: !!credentials.tokens?.accessToken,
    expiresAtMs: typeof credentials.tokens?.expiresAtMs === 'number' ? credentials.tokens.expiresAtMs : null
  }
}

export class CredentialStore {
  constructor(readonly file: string) {}

  read(): BaiduCredentials | null {
    if (!existsSync(this.file)) return null
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
      const fields = validateConnectionFields(value, INVALID_FILE)
      const tokens = validateTokens(value['tokens'], INVALID_FILE)
      return tokens ? { ...fields, tokens } : fields
    } catch { throw new Error(INVALID_FILE) }
  }

  write(value: BaiduCredentials): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }

  disconnect(): void { if (existsSync(this.file)) unlinkSync(this.file) }
}
