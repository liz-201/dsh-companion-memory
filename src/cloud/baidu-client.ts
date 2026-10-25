import { createHash } from 'node:crypto'

/**
 * 百度网盘 PCS / OAuth 客户端（无外部依赖，fetch 依赖注入）。
 *
 * 约定：
 * - 只允许官方 HTTPS 主机，重定向也逐跳校验；
 * - 所有对外抛出的错误都是 `BaiduError`，消息里只有固定文案与错误码，
 *   不回显响应 body、token、secret 或带签名的 URL；
 * - 传输上限 512MiB，分片 4MiB，分片 md5 与 block_list 严格对齐；
 * - 远程 path 必须落在 `/apps/${appFolder}/` 之内。
 */

export interface BaiduTokens {
  accessToken: string
  refreshToken?: string
  expiresAtMs?: number
}

export interface BaiduCredentials {
  appKey: string
  secretKey: string
  appFolder: string
  tokens?: BaiduTokens
}

export interface BaiduRemoteFile {
  id: number
  name: string
  path: string
  size: number
  modifiedAtMs: number
}

export class BaiduError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BaiduError'
    this.code = code
  }
}

const CHUNK_SIZE = 4 * 1024 * 1024
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024
const LIST_PAGE_SIZE = 1000
const MAX_LIST_PAGES = 1000
const REFRESH_SKEW_MS = 60_000
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5
const USER_AGENT = 'pan.baidu.com'
/**
 * 需要重新取令牌的 errno：-6/110/111 是老接口的 token 失效，
 * 20016/20017/31045 是官方 SDK 里的 access token 过期 / refresh token 过期 / 未授权。
 */
const AUTH_ERRNOS = new Set([-6, 110, 111, 20016, 20017, 31045])
const MISSING_PATH_ERRNOS = new Set([12, -9])

const PAN_FILE_API = 'https://pan.baidu.com/rest/2.0/xpan/file'
/** filemetas 在 multimedia 分组下，不是 xpan/file（官方 download_meta.go 用 /xpan/multimedia）。 */
const PAN_MULTIMEDIA_API = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
const PCS_UPLOAD_API = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'
const OAUTH_DEVICE_CODE = 'https://openapi.baidu.com/oauth/2.0/device/code'
const OAUTH_TOKEN = 'https://openapi.baidu.com/oauth/2.0/token'
/** 设备码页面必须落在官方这个路径上，不能任由服务端把用户带到别的百度页面。 */
const DEVICE_PAGE = 'https://openapi.baidu.com/device'
/**
 * xpan 文件上传使用 rtype=3 覆盖（参照 OpenList 的实际驱动请求）。
 * SDK 的枚举注释存在不同口径，不能仅据注释改成 rtype=2。
 * 但平台若仍自动重命名，`upload()` 会核对 created.path 并报错，不当作覆盖成功。
 */
const RTYPE_OVERWRITE = '3'

/** 只有这些主机可以出现在请求里（含重定向）。 */
const ALLOWED_HOSTS = new Set(['pan.baidu.com', 'openapi.baidu.com', 'd.pcs.baidu.com', 'pcs.baidu.com'])

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function numberOf(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(index + 1) : path
}

function assertAllowedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BaiduError('unsafe-url', '请求地址不合法')
  }
  if (url.protocol !== 'https:') throw new BaiduError('unsafe-url', '只允许 HTTPS 请求')
  // userinfo 可以让 `https://pan.baidu.com@evil/` 这类地址骗过 host 检查。
  if (url.username !== '' || url.password !== '') throw new BaiduError('unsafe-url', '请求地址不能带用户名或密码')
  if (url.port !== '' && url.port !== '443') throw new BaiduError('unsafe-url', '只允许 443 端口')
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host) && !host.endsWith('.pcs.baidu.com') && !host.endsWith('.baidupcs.com')) {
    throw new BaiduError('unsafe-host', '目标主机不在百度官方域名白名单内')
  }
  return url
}

/** 设备授权页必须是官方 `/device`，防止服务端把用户带去别的百度页面。 */
function assertDevicePage(raw: string): string {
  const url = assertAllowedUrl(raw)
  if (url.hostname.toLowerCase() !== 'openapi.baidu.com' || url.pathname !== new URL(DEVICE_PAGE).pathname) {
    throw new BaiduError('unsafe-url', '设备授权页不是官方地址')
  }
  return url.toString()
}

/** 拒绝 `..`、反斜杠、控制字符与空段，只返回规范化后的绝对路径。 */
function normalizeAbsolutePath(path: string): string {
  if (typeof path !== 'string' || path === '') throw new BaiduError('unsafe-path', '远程路径不能为空')
  if (!path.startsWith('/')) throw new BaiduError('unsafe-path', '远程路径必须是绝对路径')
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new BaiduError('unsafe-path', '远程路径不能包含控制字符')
  if (path.includes('\\')) throw new BaiduError('unsafe-path', '远程路径不能包含反斜杠')
  const segments = path.split('/')
  const normalized: string[] = []
  for (const segment of segments) {
    if (segment === '') continue
    if (segment === '.' || segment === '..') throw new BaiduError('unsafe-path', '远程路径不能包含相对段')
    normalized.push(segment)
  }
  if (normalized.length === 0) throw new BaiduError('unsafe-path', '远程路径不能是根目录')
  return `/${normalized.join('/')}`
}

function appFolderOf(credentials: BaiduCredentials): string {
  const folder = credentials.appFolder
  if (typeof folder !== 'string' || folder.trim() === '') throw new BaiduError('bad-config', '应用目录未配置')
  if (folder.includes('/') || folder.includes('\\') || folder.includes('..')) {
    throw new BaiduError('bad-config', '应用目录名不合法')
  }
  if (/[\u0000-\u001f\u007f]/.test(folder)) throw new BaiduError('bad-config', '应用目录名不合法')
  return folder
}

function multipartBody(chunk: Uint8Array): { body: Uint8Array; boundary: string } {
  const fingerprint = createHash('md5')
    .update(String(chunk.byteLength))
    .update(chunk.subarray(0, Math.min(32, chunk.byteLength)))
    .digest('hex')
  const boundary = `----dsh${fingerprint}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = new Uint8Array(head.byteLength + chunk.byteLength + tail.byteLength)
  body.set(head, 0)
  body.set(chunk, head.byteLength)
  body.set(tail, head.byteLength + chunk.byteLength)
  return { body, boundary }
}

function chunkMd5List(bytes: Uint8Array): string[] {
  const digests: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength)
    digests.push(createHash('md5').update(bytes.subarray(offset, end)).digest('hex'))
  }
  if (digests.length === 0) digests.push(createHash('md5').update(new Uint8Array(0)).digest('hex'))
  return digests
}

function globalFetch(): BaiduFetch {
  const candidate = (globalThis as unknown as { fetch?: BaiduFetch }).fetch
  if (typeof candidate !== 'function') throw new BaiduError('no-fetch', '运行环境没有可用的 fetch')
  return candidate
}

/**
 * 本仓库 tsconfig 只有 ES2023 lib，且 `_vendor/@types` 未随 undici-types，
 * 全局 `Response`/`RequestInit` 会被 inspector 协议的同名接口遮蔽。
 * 这里用结构化最小接口描述真正用到的成员；真实 fetch 天然满足它。
 */
export interface BaiduResponseBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(reason?: unknown): Promise<void>
  }
}

export interface BaiduHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body?: BaiduResponseBody | null
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface BaiduRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  redirect?: 'follow' | 'manual' | 'error'
  signal?: AbortSignal
}

export type BaiduFetch = (input: string, init?: BaiduRequestInit) => Promise<BaiduHttpResponse>

export interface BaiduClientOptions {
  credentials: BaiduCredentials
  fetchImpl?: typeof fetch
  saveTokens?: (tokens: BaiduTokens) => Promise<void> | void
  now?: () => number
  timeoutMs?: number
  /** 单次传输上限，默认 512MiB；测试用它验证边读边判上限，不改变生产默认。 */
  maxTransferBytes?: number
}

export class BaiduClient {
  private readonly credentials: BaiduCredentials
  private readonly fetchImpl: BaiduFetch
  private readonly saveTokens: ((tokens: BaiduTokens) => Promise<void> | void) | undefined
  private readonly clock: () => number
  private readonly timeoutMs: number
  private readonly maxTransferBytes: number
  private readonly appFolder: string
  private tokens: BaiduTokens | undefined
  private refreshing: Promise<BaiduTokens> | undefined
  private readonly requests = new Set<AbortController>()
  private cancelled = false

  cancel(): void {
    this.cancelled = true
    for (const request of this.requests) request.abort()
  }

  constructor(options: BaiduClientOptions) {
    if (!isRecord(options) || !isRecord(options.credentials)) {
      throw new BaiduError('bad-config', '缺少百度客户端配置')
    }
    this.credentials = options.credentials
    this.appFolder = appFolderOf(options.credentials)
    if (typeof options.credentials.appKey !== 'string' || options.credentials.appKey === '') {
      throw new BaiduError('bad-config', '缺少 appKey')
    }
    if (typeof options.credentials.secretKey !== 'string' || options.credentials.secretKey === '') {
      throw new BaiduError('bad-config', '缺少 secretKey')
    }
    this.fetchImpl = (options.fetchImpl as unknown as BaiduFetch | undefined) ?? globalFetch()
    this.saveTokens = options.saveTokens
    this.clock = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const cap = options.maxTransferBytes
    this.maxTransferBytes = typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : MAX_TRANSFER_BYTES
    this.tokens = options.credentials.tokens
  }

  // ── 授权 ────────────────────────────────────────────────────────────────

  async beginAuthorization(): Promise<{
    deviceCode: string
    userCode: string
    verificationUrl: string
    expiresIn: number
    interval: number
  }> {
    const json = await this.postForm(new URL(OAUTH_DEVICE_CODE), {
      client_id: this.credentials.appKey,
      response_type: 'device_code',
      scope: 'basic,netdisk'
    })
    const deviceCode = textOf(json['device_code'])
    const userCode = textOf(json['user_code'])
    const rawVerificationUrl = textOf(json['verification_url'])
    if (!deviceCode || !userCode || !rawVerificationUrl) {
      throw new BaiduError('authorization-failed', '设备码申请失败')
    }
    // 授权页固定为官方 /device，不接受任何其他主机或路径。
    const verificationUrl = assertDevicePage(rawVerificationUrl)
    return {
      deviceCode,
      userCode,
      verificationUrl,
      expiresIn: numberOf(json['expires_in'], 300),
      interval: numberOf(json['interval'], 5)
    }
  }

  /** 单次轮询：未授权时抛 `authorization_pending`，由调用方自己控制节奏。 */
  async completeAuthorization(deviceCode: string): Promise<BaiduTokens> {
    const json = await this.postForm(new URL(OAUTH_TOKEN), {
      grant_type: 'device_token',
      code: deviceCode,
      client_id: this.credentials.appKey,
      client_secret: this.credentials.secretKey
    })
    const failure = textOf(json['error'])
    if (failure) {
      if (failure === 'authorization_pending' || failure === 'authorization_waiting' || failure === 'slow_down') {
        throw new BaiduError('authorization_pending', '授权尚未完成，请稍后再试')
      }
      if (failure === 'expired_token') throw new BaiduError('authorization_expired', '设备码已过期，请重新授权')
      if (failure === 'access_denied') throw new BaiduError('authorization_denied', '授权被拒绝')
      throw new BaiduError('authorization_failed', '授权失败')
    }
    const accessToken = textOf(json['access_token'])
    if (!accessToken) throw new BaiduError('authorization_failed', '授权响应缺少访问令牌')
    const next = this.tokensFrom(accessToken, textOf(json['refresh_token']), numberOf(json['expires_in'], 0))
    await this.persistTokens(next)
    return next
  }

  // ── 列目录 ──────────────────────────────────────────────────────────────

  async list(directory: string): Promise<BaiduRemoteFile[]> {
    const dir = this.assertRemoteDirectory(directory)
    const files: BaiduRemoteFile[] = []
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const json = await this.callFileApi(
        PAN_FILE_API,
        'list',
        { query: { dir, start: page * LIST_PAGE_SIZE, limit: LIST_PAGE_SIZE, order: 'time' } },
        MISSING_PATH_ERRNOS
      )
      if (MISSING_PATH_ERRNOS.has(numberOf(json['errno'], 0))) return []
      const entries = Array.isArray(json['list']) ? json['list'] : []
      for (const entry of entries) {
        const file = this.toRemoteFile(entry)
        if (file) files.push(file)
      }
      if (json['has_more'] !== undefined ? numberOf(json['has_more'], 0) !== 1 : entries.length < LIST_PAGE_SIZE) return files
    }
    return files
  }

  // ── 上传 ────────────────────────────────────────────────────────────────

  async upload(path: string, bytes: Uint8Array): Promise<BaiduRemoteFile> {
    const remotePath = this.assertRemoteFile(path)
    if (bytes.byteLength > this.maxTransferBytes) throw new BaiduError('too-large', '文件超过传输上限')
    const slash = remotePath.lastIndexOf('/')
    const directory = slash > 0 ? remotePath.slice(0, slash) : this.appRoot()
    await this.ensureDirectory(directory)

    const blockList = chunkMd5List(bytes)
    // 请求侧 block_list 是每个分片的 md5；响应侧的 block_list 是分片序号，两者语义不同。
    const precreate = await this.callFileApi(PAN_FILE_API, 'precreate', {
      body: {
        path: remotePath,
        size: String(bytes.byteLength),
        isdir: '0',
        autoinit: '1',
        rtype: RTYPE_OVERWRITE,
        block_list: JSON.stringify(blockList)
      }
    })

    if (numberOf(precreate['return_type'], 1) === 2) {
      // 秒传：官方 scene/upload.go 在 return_type=2 时直接成功，uploadid 可以为空。
      return this.resolveRapidUpload(precreate, remotePath, directory, bytes.byteLength)
    }

    const uploadId = textOf(precreate['uploadid'])
    if (!uploadId) throw new BaiduError('upload-failed', '预上传没有返回 uploadid')

    for (const part of this.partsToUpload(precreate['block_list'], blockList.length)) {
      const digest = blockList[part]
      if (digest === undefined) throw new BaiduError('internal-error', '分片索引越界')
      const start = part * CHUNK_SIZE
      const chunk = bytes.subarray(start, Math.min(start + CHUNK_SIZE, bytes.byteLength))
      await this.uploadPart(remotePath, uploadId, part, chunk, digest)
    }

    const created = await this.callFileApi(PAN_FILE_API, 'create', {
      body: {
        path: remotePath,
        size: String(bytes.byteLength),
        isdir: '0',
        rtype: RTYPE_OVERWRITE,
        uploadid: uploadId,
        block_list: JSON.stringify(blockList)
      }
    })
    return this.toCreatedFile(created, remotePath, bytes.byteLength)
  }

  /**
   * precreate 响应里的 block_list 是**还需要上传的分片序号**（官方 upload_precreate.go
   * 是 []int），不是 md5 列表；字段缺省表示所有分片都要传。
   */
  private partsToUpload(value: unknown, total: number): number[] {
    if (value === undefined || value === null) {
      return Array.from({ length: total }, (_unused, index) => index)
    }
    if (!Array.isArray(value)) throw new BaiduError('invalid-response', '预上传返回的分片列表格式不合法')
    const parts: number[] = []
    for (const entry of value) {
      const part = typeof entry === 'number' ? entry : typeof entry === 'string' && /^\d+$/.test(entry) ? Number(entry) : Number.NaN
      if (!Number.isInteger(part) || part < 0 || part >= total) {
        throw new BaiduError('invalid-response', '预上传返回的分片序号不合法')
      }
      if (!parts.includes(part)) parts.push(part)
    }
    return parts.sort((left, right) => left - right)
  }

  /** 秒传没有 uploadid 可 create，只能靠 precreate 的 fs_id 或列目录核对。 */
  private async resolveRapidUpload(
    precreate: Json,
    remotePath: string,
    directory: string,
    size: number
  ): Promise<BaiduRemoteFile> {
    if (isRecord(precreate['info']) && precreate['info']['fs_id'] !== undefined) return this.toCreatedFile(precreate['info'], remotePath, size)
    const direct = numberOf(precreate['fs_id'], Number.NaN)
    if (Number.isFinite(direct)) {
      const modifiedSeconds = numberOf(precreate['mtime'], 0)
      return {
        id: direct,
        name: baseName(remotePath),
        path: remotePath,
        size: numberOf(precreate['size'], size),
        modifiedAtMs: modifiedSeconds > 0 ? modifiedSeconds * 1000 : this.clock()
      }
    }
    for (const entry of await this.list(directory)) {
      if (entry.path === remotePath && entry.size === size) return entry
    }
    throw new BaiduError('rapid-upload-unresolved', '秒传成功但没有拿到可核对的文件 id')
  }

  private toCreatedFile(created: Json, requestedPath: string, size: number): BaiduRemoteFile {
    const fsId = numberOf(created['fs_id'], Number.NaN)
    if (!Number.isFinite(fsId)) throw new BaiduError('upload-failed', '创建文件没有返回 fs_id')
    const createdPath = textOf(created['path'])
    if (createdPath !== undefined && this.normalizeRemote(createdPath) !== requestedPath) {
      // 同步要的是固定文件名：平台若自动重命名，必须当场失败，不能当成覆盖成功。
      throw new BaiduError('path-renamed', '云端把文件改名了，固定文件名同步失败')
    }
    const modifiedSeconds = numberOf(created['mtime'], 0)
    return {
      id: fsId,
      name: baseName(requestedPath),
      path: requestedPath,
      size: numberOf(created['size'], size),
      modifiedAtMs: modifiedSeconds > 0 ? modifiedSeconds * 1000 : this.clock()
    }
  }

  // ── 下载 ────────────────────────────────────────────────────────────────

  async download(file: BaiduRemoteFile): Promise<Uint8Array> {
    if (!Number.isFinite(file.id)) throw new BaiduError('bad-request', '缺少文件 id')
    if (file.size > this.maxTransferBytes) throw new BaiduError('too-large', '文件超过传输上限')
    // filemetas 属于 multimedia 分组（官方 download_meta.go），不能走 xpan/file。
    const meta = await this.callFileApi(PAN_MULTIMEDIA_API, 'filemetas', {
      query: { fsids: JSON.stringify([file.id]), dlink: '1', thumb: '0', extra: '1' }
    })
    const entries = Array.isArray(meta['list']) ? meta['list'] : []
    let dlink: string | undefined
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      if (numberOf(entry['fs_id'], -1) !== file.id) continue
      dlink = textOf(entry['dlink'])
      break
    }
    if (!dlink) throw new BaiduError('missing-dlink', '文件没有可用的下载地址')

    const url = assertAllowedUrl(dlink)
    if (!url.searchParams.has('access_token')) {
      const token = await this.accessToken(false)
      url.searchParams.set('access_token', token.accessToken)
    }
    const read = async (response: BaiduHttpResponse): Promise<Uint8Array> => {
      if (!response.ok) throw new BaiduError(`baidu-http-${response.status}`, '下载请求失败')
      return this.readCapped(response)
    }
    try {
      return await this.request(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT } }, read)
    } catch (error) {
      if (!(error instanceof BaiduError) || (error.code !== 'baidu-http-401' && error.code !== 'baidu-http-403')) {
        throw error
      }
      // dlink 里的令牌过期：刷新一次再试，仍失败才交给调用方。
      const refreshed = await this.accessToken(true)
      url.searchParams.set('access_token', refreshed.accessToken)
      return this.request(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT } }, read)
    }
  }

  // ── 内部：HTTP ──────────────────────────────────────────────────────────

  private transportError(signal: AbortSignal): BaiduError {
    if (this.cancelled) return new BaiduError('cancelled', '请求已取消')
    return signal.aborted ? new BaiduError('timeout', '请求超时') : new BaiduError('network', '网络请求失败')
  }

  /**
   * 一次逻辑请求 = 一个超时预算，**包含读响应体**。
   * 计时器只在 body 读完（或读失败）之后才清，所以「头立刻回来、body 一直不来」
   * 也会被 abort 成 timeout，而不是无限等下去。重定向逐跳校验并共用同一预算。
   */
  private async request<T>(
    url: URL,
    init: BaiduRequestInit,
    read: (response: BaiduHttpResponse) => Promise<T>
  ): Promise<T> {
    if (this.cancelled) throw new BaiduError('cancelled', '请求已取消')
    assertAllowedUrl(url.toString())
    const controller = new AbortController()
    this.requests.add(controller)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    try {
      let current = url
      let response: BaiduHttpResponse | undefined
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        try {
          response = await this.fetchImpl(current.toString(), {
            ...init,
            signal: controller.signal,
            redirect: 'manual'
          })
        } catch {
          throw this.transportError(controller.signal)
        }
        if (response.status < 300 || response.status >= 400) break
        const location = response.headers.get('location')
        if (!location) throw new BaiduError('unexpected-redirect', '重定向缺少目标地址')
        current = assertAllowedUrl(new URL(location, current).toString())
        response = undefined
      }
      if (!response) throw new BaiduError('unexpected-redirect', '重定向次数超过上限')
      try {
        return await read(response)
      } catch (error) {
        if (error instanceof BaiduError) throw error
        throw this.transportError(controller.signal)
      }
    } finally {
      clearTimeout(timer)
      this.requests.delete(controller)
    }
  }

  private async readJson(response: BaiduHttpResponse): Promise<Json> {
    const raw = await response.text()
    if (raw === '') return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BaiduError('invalid-response', '响应不是合法 JSON')
    }
    if (!isRecord(parsed)) throw new BaiduError('invalid-response', '响应不是 JSON 对象')
    return parsed
  }

  /** 边读边累计，超过上限立刻取消流并失败，不等整个 body 落地。 */
  private async readCapped(response: BaiduHttpResponse): Promise<Uint8Array> {
    const declared = numberOf(response.headers.get('content-length'), 0)
    if (declared > this.maxTransferBytes) throw new BaiduError('too-large', '文件超过传输上限')
    const body = response.body
    if (!body || typeof body.getReader !== 'function') {
      const fallback = new Uint8Array(await response.arrayBuffer())
      if (fallback.byteLength > this.maxTransferBytes) throw new BaiduError('too-large', '文件超过传输上限')
      return fallback
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > this.maxTransferBytes) {
        try {
          await reader.cancel()
        } catch {
          // 流已经坏了，取消失败也不影响这里的结论。
        }
        throw new BaiduError('too-large', '文件超过传输上限')
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }

  private async postForm(url: URL, fields: Record<string, string>): Promise<Json> {
    const body = new URLSearchParams(fields).toString()
    return this.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body
      },
      response => this.readJson(response)
    )
  }

  /**
   * 调 pan.baidu.com 文件接口。`tolerate` 里的 errno 原样返回给调用方判断，
   * 其余非零 errno 一律抛脱敏错误；鉴权类 errno 只刷新重试一次。
   */
  private async callFileApi(
    base: string,
    method: string,
    options: { query?: Record<string, string | number>; body?: Record<string, string> },
    tolerate: ReadonlySet<number> = new Set<number>()
  ): Promise<Json> {
    let lastAuthFailure: BaiduError | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt > 0)
      const url = new URL(base)
      url.searchParams.set('method', method)
      url.searchParams.set('access_token', token.accessToken)
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value))

      const json = options.body
        ? await this.request(
            url,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
              body: new URLSearchParams(options.body).toString()
            },
            response => this.readJson(response)
          )
        : await this.request(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT } }, response => this.readJson(response))
      const errno = numberOf(json['errno'], 0)
      if (errno === 0) return json
      if (tolerate.has(errno)) return json
      const failure = new BaiduError(`baidu-${errno}`, `百度文件接口返回错误码 ${errno}`)
      if (AUTH_ERRNOS.has(errno) && attempt === 0) {
        lastAuthFailure = failure
        continue
      }
      throw failure
    }
    throw lastAuthFailure ?? new BaiduError('baidu-unknown', '百度文件接口调用失败')
  }

  private async uploadPart(
    remotePath: string,
    uploadId: string,
    partSeq: number,
    chunk: Uint8Array,
    expectedMd5: string
  ): Promise<void> {
    let lastAuthFailure: BaiduError | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt > 0)
      const url = new URL(PCS_UPLOAD_API)
      url.searchParams.set('method', 'upload')
      url.searchParams.set('access_token', token.accessToken)
      url.searchParams.set('type', 'tmpfile')
      url.searchParams.set('path', remotePath)
      url.searchParams.set('uploadid', uploadId)
      url.searchParams.set('partseq', String(partSeq))
      const { body, boundary } = multipartBody(chunk)
      const json = await this.request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'User-Agent': USER_AGENT },
          body
        },
        response => this.readJson(response)
      )
      const errno = numberOf(json['errno'], 0)
      if (errno === 0) {
        // 服务端回报的分片 md5 与本地不一致说明分片内容有问题，继续 create 只会得到坏文件。
        const echoed = textOf(json['md5'])
        if (echoed !== undefined && echoed.toLowerCase() !== expectedMd5) {
          throw new BaiduError('part-md5-mismatch', '服务端返回的分片 md5 与本地不一致')
        }
        return
      }
      const failure = new BaiduError(`baidu-${errno}`, `分片上传失败，错误码 ${errno}`)
      if (AUTH_ERRNOS.has(errno) && attempt === 0) {
        lastAuthFailure = failure
        continue
      }
      throw failure
    }
    throw lastAuthFailure ?? new BaiduError('baidu-unknown', '分片上传失败')
  }

  // ── 内部：令牌 ──────────────────────────────────────────────────────────

  private tokensFrom(accessToken: string, refreshToken: string | undefined, expiresIn: number): BaiduTokens {
    const tokens: BaiduTokens = { accessToken }
    const resolvedRefresh = refreshToken ?? this.tokens?.refreshToken
    if (resolvedRefresh) tokens.refreshToken = resolvedRefresh
    if (expiresIn > 0) tokens.expiresAtMs = this.clock() + expiresIn * 1000
    return tokens
  }

  private async persistTokens(tokens: BaiduTokens): Promise<void> {
    if (this.saveTokens) {
      try {
        await this.saveTokens(tokens)
      } catch {
        throw new BaiduError('token-store-failed', '令牌持久化失败')
      }
    }
    this.tokens = tokens
  }

  private isFresh(tokens: BaiduTokens): boolean {
    if (typeof tokens.expiresAtMs !== 'number') return true
    return tokens.expiresAtMs - this.clock() > REFRESH_SKEW_MS
  }

  private async accessToken(force: boolean): Promise<BaiduTokens> {
    const current = this.tokens
    if (!force && current && this.isFresh(current)) return current
    if (!current?.refreshToken) throw new BaiduError('reauth-required', '缺少可刷新的访问令牌，需要重新授权')
    return this.refreshTokens(current.refreshToken)
  }

  /** 并发刷新只发一次请求，其余调用等同一个 promise。 */
  private refreshTokens(refreshToken: string): Promise<BaiduTokens> {
    if (this.refreshing) return this.refreshing
    const run = this.doRefresh(refreshToken)
    this.refreshing = run
    void run.then(
      () => {
        if (this.refreshing === run) this.refreshing = undefined
      },
      () => {
        if (this.refreshing === run) this.refreshing = undefined
      }
    )
    return run
  }

  private async doRefresh(refreshToken: string): Promise<BaiduTokens> {
    const json = await this.postForm(new URL(OAUTH_TOKEN), {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.credentials.appKey,
      client_secret: this.credentials.secretKey
    })
    const accessToken = textOf(json['access_token'])
    if (!accessToken) throw new BaiduError('refresh-failed', '刷新访问令牌失败，需要重新授权')
    const next = this.tokensFrom(accessToken, textOf(json['refresh_token']), numberOf(json['expires_in'], 0))
    await this.persistTokens(next)
    return next
  }

  // ── 内部：路径与目录 ────────────────────────────────────────────────────

  private appRoot(): string {
    return `/apps/${this.appFolder}`
  }

  private normalizeRemote(path: string): string {
    const normalized = normalizeAbsolutePath(path)
    const root = this.appRoot()
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      throw new BaiduError('path-outside-app-folder', '远程路径超出应用目录')
    }
    return normalized
  }

  private assertRemoteDirectory(directory: string): string {
    if (directory === '' || directory === '/') return this.appRoot()
    return this.normalizeRemote(directory)
  }

  private assertRemoteFile(path: string): string {
    const normalized = this.normalizeRemote(path)
    if (normalized === this.appRoot()) throw new BaiduError('unsafe-path', '远程路径必须是文件而不是目录')
    return normalized
  }

  private toRemoteFile(entry: unknown): BaiduRemoteFile | undefined {
    if (!isRecord(entry)) return undefined
    if (numberOf(entry['isdir'], 0) === 1) return undefined
    const rawPath = textOf(entry['path'])
    if (!rawPath) return undefined
    let path: string
    try {
      path = this.normalizeRemote(rawPath)
    } catch {
      // 服务端返回越权路径时直接丢弃，绝不返回给调用方。
      return undefined
    }
    const id = numberOf(entry['fs_id'], Number.NaN)
    if (!Number.isFinite(id)) return undefined
    const seconds = numberOf(entry['server_mtime'], 0)
    return {
      id,
      name: textOf(entry['server_filename']) ?? baseName(path),
      path,
      size: numberOf(entry['size'], 0),
      modifiedAtMs: seconds > 0 ? seconds * 1000 : this.clock()
    }
  }

  private async ensureDirectory(directory: string): Promise<void> {
    const target = this.normalizeRemote(directory)
    // Create each application-owned level; first-use nested directories do not
    // necessarily exist, and precreate cannot be assumed to create their parents.
    const root = this.appRoot(), paths = [root]
    let current = root
    for (const segment of target.slice(root.length).split('/').filter(Boolean)) {
      current += `/${segment}`
      paths.push(current)
    }
    for (const path of paths) {
      await this.callFileApi(PAN_FILE_API, 'create',
        { body: { path, size: '0', isdir: '1', rtype: '0' } }, new Set([-8, 12]))
    }
  }
}
