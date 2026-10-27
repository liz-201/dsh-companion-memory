import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Config } from '../config.js'
import type { Database } from '../storage/database.js'
import { Repositories } from '../storage/repositories.js'
import { exportPortable, importPortable, readPortable, refreshPortableBaseline, snapshotForTransfer, stableJson, PortableImportError, type ImportReport } from '../storage/portable.js'
import { CredentialStore, parseConnection, serializeConnection, validateConnectionFields } from './credentials.js'
import { BaiduClient, type BaiduCredentials, type BaiduRemoteFile } from './baidu-client.js'
import { previewOwnerMerge, confirmOwnerMerge, OwnerMergeInputError, type OwnerMergePreview } from '../storage/owner-merge.js'

export interface CloudTransport {
  cancel?(): void
  list(directory: string): Promise<BaiduRemoteFile[]>
  upload(path: string, bytes: Uint8Array): Promise<BaiduRemoteFile>
  download(file: BaiduRemoteFile): Promise<Uint8Array>
}
/** 云端另有记忆库时给界面的结构化线索：不阻断同步，也不静默。 */
export interface ForeignLibrary { path: string; companionDigest: string; ownerDigest: string; updatedAtMs: number }
export interface TransferStatus {
  enabled: boolean
  connected: boolean
  busy: boolean
  ready: boolean
  lastSyncAtMs: number | null
  lastExport: string | null
  imported: number
  conflicts: number
  lineageMissing: boolean
  error: string | null
  foreignLibraries: ForeignLibrary[]
  notice: string | null
}
export interface LibraryManifestFile { path: string; size: number; checksum: string; deviceId: string; updatedAtMs: number; modifiedAtMs: number }
export interface LibraryManifest { format: string; companionId: string; ownerId: string; updatedAtMs: number; files: LibraryManifestFile[] }
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const MAX_FILE_BYTES = 512 * 1024 * 1024
/** 清单只放定位与校验信息：任何令牌、密钥都不允许进这个文件（它会留在网盘上）。 */
export const LIBRARY_MANIFEST = 'manifest.json'
export const MANIFEST_FORMAT = 'dsh-companion-memory/library@1'
const MAX_MANIFEST_BYTES = 512 * 1024
const FOREIGN_SCAN_MS = 5 * 60 * 1000

export function libraryManifestPath(directory: string): string { return `${directory}/${LIBRARY_MANIFEST}` }

/**
 * 只保留已知字段：清单里任何多余键（尤其凭据）都会被丢弃，重新上传时也不会被带回去。
 */
export function sanitizeManifest(raw: unknown): LibraryManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record['format'] !== MANIFEST_FORMAT) return null
  const companionId = typeof record['companionId'] === 'string' ? record['companionId'] : ''
  const ownerId = typeof record['ownerId'] === 'string' ? record['ownerId'] : ''
  if (!companionId || !ownerId) return null
  const files: LibraryManifestFile[] = []
  for (const entry of Array.isArray(record['files']) ? record['files'] : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const file = entry as Record<string, unknown>
    const path = typeof file['path'] === 'string' ? file['path'] : ''
    const checksum = typeof file['checksum'] === 'string' ? file['checksum'] : ''
    const size = typeof file['size'] === 'number' && Number.isFinite(file['size']) ? file['size'] : -1
    if (!path || !/^[0-9a-f]{64}$/.test(checksum) || size < 0) continue
    files.push({
      path, size, checksum,
      deviceId: typeof file['deviceId'] === 'string' ? file['deviceId'] : '',
      updatedAtMs: typeof file['updatedAtMs'] === 'number' && Number.isFinite(file['updatedAtMs']) ? file['updatedAtMs'] : 0,
      modifiedAtMs: typeof file['modifiedAtMs'] === 'number' && Number.isFinite(file['modifiedAtMs']) ? file['modifiedAtMs'] : 0
    })
  }
  const updatedAtMs = typeof record['updatedAtMs'] === 'number' && Number.isFinite(record['updatedAtMs']) ? record['updatedAtMs'] : 0
  return { format: MANIFEST_FORMAT, companionId, ownerId, updatedAtMs, files }
}

/** Per-device snapshots avoid cloud last-writer-wins erasing an offline peer. */
export class MemoryTransfer {
  readonly credentials: CredentialStore
  readonly directory: string
  private readonly repos: Repositories
  private readonly clientFactory: (credentials: BaiduCredentials) => CloudTransport
  private readonly fetchImpl: typeof fetch | undefined
  private readonly assertMergeIdle: () => void
  private pending: Promise<TransferStatus> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private startupDeadline: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private finishedStartup = false
  private startup: Promise<void> = Promise.resolve()
  private lastSyncAtMs: number | null = null
  private lastExport: string | null = null
  private imported = 0
  private conflicts = 0
  private missingLineage = false
  private error: string | null = null
  private foreign: ForeignLibrary[] = []
  private notice: string | null = null
  private foreignScanAt = 0
  private changedDuringUpload = false
  private authorization: { client: BaiduClient; deviceCode: string; expiresAt: number } | null = null
  private credentialRevision = 0
  private activeTransport: CloudTransport | null = null
  private ownerMergeCandidate: BaiduRemoteFile | null = null
  private ownerMergeBusy = false
  private readonly ownerMergePreviews = new Map<string, { file: string; preview: OwnerMergePreview; expiresAtMs: number }>()

  constructor(private readonly db: Database, private readonly config: Config, private readonly deviceId: string,
    options: { credentialFile?: string; clientFactory?: (credentials: BaiduCredentials) => CloudTransport; fetchImpl?: typeof fetch; assertMergeIdle?: () => void } = {}) {
    this.repos = new Repositories(db)
    this.directory = join(config.storage.directory, 'exports')
    this.credentials = new CredentialStore(options.credentialFile ?? (config.cloud.credentialFile || join(config.storage.directory, 'credentials', 'baidu.json')))
    this.fetchImpl = options.fetchImpl
    this.assertMergeIdle = options.assertMergeIdle ?? (() => {})
    this.clientFactory = options.clientFactory ?? (credentials => this.client(credentials))
  }

  get ready(): Promise<void> { return this.startup }
  get isReady(): boolean { return this.finishedStartup }

  private client(credentials: BaiduCredentials): BaiduClient {
    const revision = this.credentialRevision
    return new BaiduClient({ credentials, fetchImpl: this.fetchImpl, saveTokens: tokens => {
      if (this.stopped || revision !== this.credentialRevision) throw new Error('authorization cancelled')
      this.credentials.write({ ...credentials, tokens })
    } })
  }

  private enabled(): boolean {
    const value = this.db.isOpen ? this.repos.getSetting('local.cloud.enabled') : undefined
    return value === undefined ? this.config.cloud.enabled : value === '1'
  }

  status(): TransferStatus {
    let connected = false
    try { connected = !!this.credentials.read()?.tokens?.accessToken } catch {}
    return { enabled: this.enabled(), connected, busy: this.pending !== null || this.ownerMergeBusy, ready: this.finishedStartup,
      lastSyncAtMs: this.lastSyncAtMs, lastExport: this.lastExport, imported: this.imported,
      conflicts: this.conflicts, lineageMissing: this.missingLineage, error: this.error,
      foreignLibraries: this.foreign, notice: this.notice }
  }

  start(): void {
    if (this.timer || this.stopped) return
    if (this.enabled() && this.config.cloud.syncOnStartup) {
      let timedOut = false
      this.startupDeadline = setTimeout(() => { timedOut = true; this.activeTransport?.cancel?.() }, this.config.cloud.startupTimeoutSeconds * 1000)
      this.startupDeadline.unref()
      this.startup = this.sync().then(() => {}).finally(() => {
        if (this.startupDeadline) clearTimeout(this.startupDeadline)
        this.startupDeadline = null
        if (timedOut) this.error = '启动云端检查超时，已继续使用本地记忆，稍后自动重试。'
        this.finishedStartup = true
      })
    }
    else this.finishedStartup = true
    this.timer = setInterval(() => { if (this.enabled()) void this.sync() }, this.config.cloud.intervalSeconds * 1000)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.activeTransport?.cancel?.()
    this.authorization?.client.cancel()
    if (this.startupDeadline) clearTimeout(this.startupDeadline)
    this.startupDeadline = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.pending
  }

  /** Always produces a complete, directly importable file; no raw DB/WAL copying. */
  exportLocal(): { file: string; id: string; messages: number; memories: number; upload: string } {
    if (this.stopped || !this.db.isOpen) throw new Error('记忆服务已关闭。')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `memory-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.companion.json`)
    const result = exportPortable(this.db, this.config, file, { includePlugin: false })
    this.lastExport = file
    const auto = this.enabled() && this.config.cloud.autoUpload
    if (auto) void this.sync()
    return { ...result, upload: auto ? 'queued' : 'disabled' }
  }

  importFile(file: string): ImportReport {
    if (this.stopped || !this.db.isOpen) throw new Error('记忆服务已关闭。')
    const transfer = readPortable(file)
    // importPortable backs up, validates schema/owner/checksum and merges in one transaction.
    const result = importPortable(this.db, this.config, transfer.payload, transfer.checksum)
    refreshPortableBaseline(this.db, transfer.payload, transfer.checksum)
    this.imported += result.alreadyImported ? 0 : 1
    this.conflicts += result.conflicts
    this.missingLineage ||= result.lineageMissing
    return result
  }

  importBytes(bytes: Uint8Array): ImportReport {
    if (bytes.length > MAX_FILE_BYTES) throw new Error('记忆文件超过大小限制。')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `import-${randomUUID()}.tmp`)
    try { writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' }); return this.importFile(file) }
    finally { if (existsSync(file)) unlinkSync(file) }
  }

  /** Stage the exact source file; preview rolls every simulated database change back. */
  prepareOwnerMerge(bytes: Uint8Array): OwnerMergePreview & { previewToken: string; expiresAtMs: number } {
    if (this.stopped || !this.db.isOpen) throw new Error('记忆服务已关闭。')
    if (bytes.length > MAX_FILE_BYTES) throw new Error('记忆文件超过大小限制。')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `owner-merge-source-${randomUUID()}.companion.json`)
    try {
      writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
      const source = readPortable(file)
      const preview = previewOwnerMerge(this.db, this.config, source.payload, source.checksum)
      const previewToken = randomUUID(), expiresAtMs = Date.now() + 10 * 60000
      this.ownerMergePreviews.set(previewToken, { file, preview, expiresAtMs })
      while (this.ownerMergePreviews.size > 3) {
        const oldest = this.ownerMergePreviews.keys().next().value!
        const entry = this.ownerMergePreviews.get(oldest)!
        this.ownerMergePreviews.delete(oldest)
        if (existsSync(entry.file)) unlinkSync(entry.file)
      }
      return { ...preview, previewToken, expiresAtMs }
    } catch (error) { if (existsSync(file)) unlinkSync(file); throw error }
  }

  confirmOwnerMerge(previewToken: string, confirmation: string): ImportReport & { sourceArchive: string } {
    if (this.stopped || !this.db.isOpen) throw new Error('记忆服务已关闭。')
    if (this.pending || this.ownerMergeBusy) throw new Error('正在同步，请稍后确认合并。')
    if (confirmation !== 'same-owner-keep-both') throw new OwnerMergeInputError('请明确确认两份记忆属于同一个人，并保留双方历史。')
    const entry = this.ownerMergePreviews.get(previewToken)
    if (!entry || entry.expiresAtMs < Date.now()) throw new OwnerMergeInputError('合并预览已过期，请重新预览。')
    const source = readPortable(entry.file)
    this.assertMergeIdle()
    const report = confirmOwnerMerge(this.db, this.config, source.payload, source.checksum, entry.preview)
    this.ownerMergePreviews.delete(previewToken)
    this.imported += report.alreadyImported ? 0 : 1
    this.conflicts += report.conflicts
    this.missingLineage ||= report.lineageMissing
    this.ownerMergeCandidate = null
    this.error = null
    return { ...report, sourceArchive: entry.file }
  }

  /** Download only the conflicting library found by normal sync; confirmation remains separate. */
  async prepareCloudOwnerMerge(): Promise<OwnerMergePreview & { previewToken: string; expiresAtMs: number }> {
    if (this.pending || this.ownerMergeBusy) throw new OwnerMergeInputError('正在同步，请等待同步结束再预览网盘记忆。')
    if (!this.ownerMergeCandidate) throw new OwnerMergeInputError('没有发现待配对的网盘记忆。请先点“立即同步”检查身份，或选择另一台导出的记忆文件；预览不会自动执行同步。')
    if (this.ownerMergeBusy || this.stopped) throw new Error('当前不能预览，请稍后重试。')
    const credentials = this.credentials.read()
    if (!credentials?.tokens?.accessToken) throw new Error('请先连接百度网盘。')
    this.ownerMergeBusy = true
    const client = this.clientFactory(credentials)
    this.activeTransport = client
    try {
      const bytes = await client.download(this.ownerMergeCandidate)
      if (this.stopped) throw new Error('记忆服务已关闭。')
      return this.prepareOwnerMerge(bytes)
    } finally { this.ownerMergeBusy = false; this.activeTransport = null }
  }

  async beginAuthorization(input: { appKey: string; secretKey: string; appFolder: string }) {
    if (this.stopped) throw new Error('记忆服务已关闭。')
    if (this.pending) throw new Error('正在同步，请稍后连接。')
    const credentials = validateConnectionFields({ appKey: input.appKey, secretKey: input.secretKey, appFolder: input.appFolder })
    const revision = ++this.credentialRevision
    const client = this.client(credentials)
    const result = await client.beginAuthorization()
    if (this.stopped || revision !== this.credentialRevision) throw new Error('authorization cancelled')
    this.authorization = { client, deviceCode: result.deviceCode, expiresAt: Date.now() + result.expiresIn * 1000 }
    return { userCode: result.userCode, verificationUrl: result.verificationUrl, expiresIn: result.expiresIn, interval: result.interval }
  }

  async finishAuthorization(): Promise<TransferStatus> {
    const authorization = this.authorization
    if (!authorization || authorization.expiresAt < Date.now()) throw new Error('授权已过期，请重新连接。')
    await authorization.client.completeAuthorization(authorization.deviceCode)
    if (this.stopped || this.authorization !== authorization) throw new Error('authorization cancelled')
    this.authorization = null
    this.repos.setSetting('local.cloud.enabled', '1', Date.now())
    return this.sync()
  }

  async disconnect(): Promise<void> {
    this.credentialRevision++
    this.authorization?.client.cancel()
    this.authorization = null
    this.activeTransport?.cancel?.()
    this.repos.setSetting('local.cloud.enabled', '0', Date.now())
    await this.pending
    this.credentials.disconnect()
    this.error = null
  }

  /** 导出连接配置：默认不带令牌，避免两台机器争用同一个 refreshToken 互相踢下线。 */
  exportConnection(options: { includeTokens?: boolean } = {}): string {
    const credentials = this.credentials.read()
    if (!credentials) throw new Error('尚未连接百度网盘，没有可导出的连接配置。')
    return serializeConnection(credentials, options)
  }

  /** 导入连接配置：写凭据文件、开启云同步，然后立刻同步一次。 */
  async importConnection(text: string): Promise<TransferStatus> {
    if (this.stopped || !this.db.isOpen) throw new Error('记忆服务已关闭。')
    if (this.pending) throw new Error('正在同步，请稍后导入。')
    const credentials = parseConnection(text)
    this.credentialRevision++
    this.authorization?.client.cancel()
    this.authorization = null
    this.credentials.write(credentials)
    this.repos.setSetting('local.cloud.enabled', '1', Date.now())
    this.error = null
    return this.sync()
  }

  sync(): Promise<TransferStatus> {
    if (this.pending) return this.pending
    if (this.ownerMergeBusy) return Promise.resolve(this.status())
    if (this.stopped || !this.db.isOpen) return Promise.resolve(this.status())
    this.pending = this.runSync().catch(error => {
      // Provider errors can contain query credentials; detailed raw errors never reach logs/UI.
      this.error = error instanceof PortableImportError && error.code === 'owner-mismatch'
        ? '云端与本机被识别为属于不同主人（编号不同），已保留双方记忆。如果确实属于同一个人，请在控制台预览“两台已有记忆首次配对”，确认后合并。'
        : '百度网盘同步未完成，请检查网络、应用权限或重新授权。本地记忆已保留。'
      return this.status()
    }).finally(() => {
      this.pending = null
      this.activeTransport = null
      if (this.changedDuringUpload && !this.stopped) { this.changedDuringUpload = false; void this.sync() }
    })
    return this.pending
  }

  private async runSync(): Promise<TransferStatus> {
    if (!this.enabled()) return this.status()
    const credentials = this.credentials.read()
    if (!credentials?.tokens?.accessToken) throw new Error('authorization required')
    const client = this.clientFactory(credentials)
    this.activeTransport = client
    const root = `/apps/${credentials.appFolder}/dsh-companion-memory`
    const directory = `${root}/${digest(this.config.companion.id).slice(0, 24)}`
    const ownPath = `${directory}/${digest(this.deviceId).slice(0, 24)}.companion.json`
    this.notice = null
    const files = await client.list(directory)
    const manifest = await this.readManifest(client, files)
    await this.detectForeignLibraries(client, root, directory)
    for (const file of files.filter(file => file.name.endsWith('.companion.json')).sort((a, b) => Number(b.path === ownPath) - Number(a.path === ownPath) || a.modifiedAtMs - b.modifiedAtMs || a.path.localeCompare(b.path))) {
      if (this.stopped) return this.status()
      if (!file.path.startsWith(directory + '/') || basename(file.path) !== file.name || file.size > MAX_FILE_BYTES) throw new Error('invalid cloud snapshot')
      // 每个包都下载并导入：跳过下载无法做到安全。清单只能证明“某个时刻某份字节”的校验和，
      // 云端 mtime 粒度粗（同秒内两次上传同长度内容无法区分），实测会出现“清单滞后 → 新包被误跳过 →
      // 本地内容永久停在旧值”。导入本身是幂等的（回执 + 内容哈希），重复下载只花带宽，不会写坏数据。
      const bytes = await client.download(file)
      if (this.stopped) return this.status()
      try { this.importBytes(bytes) }
      catch (error) {
        if (error instanceof PortableImportError && error.code === 'owner-mismatch') this.ownerMergeCandidate = file
        throw error
      }
    }
    if (this.stopped) return this.status()
    const fingerprint = digest(stableJson(snapshotForTransfer(this.db)))
    const previous = this.repos.getSetting('local.cloud.upload-fingerprint')
    if (this.config.cloud.autoUpload && (fingerprint !== previous || !files.some(file => file.path === ownPath))) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const file = join(this.directory, `cloud-${randomUUID()}.tmp`)
      try {
        exportPortable(this.db, this.config, file, { includePlugin: false })
        const bytes = readFileSync(file)
        const remote = await client.upload(ownPath, bytes)
        if (remote.path !== ownPath || remote.size !== bytes.length) throw new Error('cloud upload metadata differs')
        const persisted = await client.download(remote)
        if (digest(persisted) !== digest(bytes)) throw new Error('cloud readback checksum differs')
        if (this.stopped || !this.db.isOpen) return this.status()
        await this.writeManifest(client, directory, ownPath, bytes, manifest, remote.modifiedAtMs)
        const target = join(this.directory, 'latest-cloud.companion.json')
        renameSync(file, target)
        this.lastExport = target
        this.repos.setSetting('local.cloud.upload-fingerprint', fingerprint, Date.now())
        this.changedDuringUpload = digest(stableJson(snapshotForTransfer(this.db))) !== fingerprint
      } finally { if (existsSync(file)) unlinkSync(file) }
    }
    this.lastSyncAtMs = Date.now()
    this.error = null
    return this.status()
  }

  /** 清单只是定位与校验信息，读不到就不跳过下载，绝不因为清单损坏而漏导入。 */
  private async readManifest(client: CloudTransport, files: BaiduRemoteFile[]): Promise<LibraryManifest | null> {
    const entry = files.find(file => file.name === LIBRARY_MANIFEST)
    if (!entry || entry.size > MAX_MANIFEST_BYTES) return null
    try {
      const bytes = await client.download(entry)
      if (bytes.length > MAX_MANIFEST_BYTES) return null
      return sanitizeManifest(JSON.parse(Buffer.from(bytes).toString('utf8')))
    } catch { return null }
  }

  private async writeManifest(client: CloudTransport, directory: string, ownPath: string, bytes: Uint8Array, previous: LibraryManifest | null, modifiedAtMs: number): Promise<void> {
    const ownerId = this.repos.getSetting('owner.id') ?? ''
    if (!ownerId) return
    const nowMs = Date.now()
    const entry: LibraryManifestFile = { path: ownPath, size: bytes.length, checksum: digest(bytes), deviceId: this.deviceId, updatedAtMs: nowMs, modifiedAtMs }
    const files = (previous?.files ?? []).filter(file => file.path !== ownPath).concat(entry).sort((a, b) => a.path.localeCompare(b.path))
    const unchanged = previous && previous.companionId === this.config.companion.id && previous.ownerId === ownerId && stableJson(previous.files) === stableJson(files)
    if (unchanged) return
    const manifest: LibraryManifest = { format: MANIFEST_FORMAT, companionId: this.config.companion.id, ownerId, updatedAtMs: nowMs, files }
    try {
      await client.upload(libraryManifestPath(directory), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
    } catch { this.notice = '云端清单写入失败，本次同步已完成，下次同步会重试。' }
  }

  /**
   * companion.id 不一致时云端目录不同，`list` 只会返回空列表并静默上传到新目录，
   * 所以这里按父目录下各子目录的清单比对，把差异显式报给界面。
   */
  private async detectForeignLibraries(client: CloudTransport, root: string, directory: string): Promise<void> {
    const now = Date.now()
    if (now - this.foreignScanAt < FOREIGN_SCAN_MS) return
    this.foreignScanAt = now
    try {
      const siblings = new Set<string>()
      for (const entry of await client.list(root)) {
        const segment = entry.path.slice(root.length + 1).split('/')[0]
        if (!segment) continue
        const path = `${root}/${segment}`
        if (path !== directory) siblings.add(path)
      }
      const found: ForeignLibrary[] = []
      for (const path of [...siblings].slice(0, 8)) {
        const manifest = await this.readManifest(client, await client.list(path))
        if (!manifest || manifest.companionId === this.config.companion.id) continue
        found.push({
          path,
          companionDigest: path.slice(root.length + 1, root.length + 25),
          ownerDigest: manifest.ownerId.slice(0, 8),
          updatedAtMs: manifest.updatedAtMs
        })
      }
      this.foreign = found
      if (found.length > 0) this.notice = `云端另有记忆库（id 摘要 ${found.map(item => item.companionDigest).join('、')}），与本机 companion.id 不同，本机不会合并它。`
    } catch { /* 旁路探测失败不影响本次同步 */ }
  }
}
