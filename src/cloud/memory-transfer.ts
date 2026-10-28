import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Config } from '../config.js'
import type { Database } from '../storage/database.js'
import { Repositories } from '../storage/repositories.js'
import { loadPanelSettings } from '../panel/settings.js'
import { recoverCapabilityExtractions } from '../runtime/extraction-recovery.js'
import { exportPortable, importPortable, readPortable, refreshPortableBaseline, snapshotForTransfer, stableJson, PortableImportError, type ImportReport } from '../storage/portable.js'
import { CredentialStore } from './credentials.js'
import { BaiduClient, type BaiduCredentials, type BaiduRemoteFile } from './baidu-client.js'

export interface CloudTransport {
  cancel?(): void
  list(directory: string): Promise<BaiduRemoteFile[]>
  upload(path: string, bytes: Uint8Array): Promise<BaiduRemoteFile>
  download(file: BaiduRemoteFile): Promise<Uint8Array>
}
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
}
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const MAX_FILE_BYTES = 512 * 1024 * 1024

/** Per-device snapshots avoid cloud last-writer-wins erasing an offline peer. */
export class MemoryTransfer {
  readonly credentials: CredentialStore
  readonly directory: string
  private readonly repos: Repositories
  private readonly clientFactory: (credentials: BaiduCredentials) => CloudTransport
  private readonly fetchImpl: typeof fetch | undefined
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
  private changedDuringUpload = false
  private authorization: { client: BaiduClient; deviceCode: string; expiresAt: number } | null = null
  private credentialRevision = 0
  private activeTransport: CloudTransport | null = null

  constructor(private readonly db: Database, private readonly config: Config, private readonly deviceId: string,
    options: { credentialFile?: string; clientFactory?: (credentials: BaiduCredentials) => CloudTransport; fetchImpl?: typeof fetch } = {}) {
    this.repos = new Repositories(db)
    this.directory = join(config.storage.directory, 'exports')
    this.credentials = new CredentialStore(options.credentialFile ?? (config.cloud.credentialFile || join(config.storage.directory, 'credentials', 'baidu.json')))
    this.fetchImpl = options.fetchImpl
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
    return { enabled: this.enabled(), connected, busy: this.pending !== null, ready: this.finishedStartup,
      lastSyncAtMs: this.lastSyncAtMs, lastExport: this.lastExport, imported: this.imported,
      conflicts: this.conflicts, lineageMissing: this.missingLineage, error: this.error }
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
    loadPanelSettings(new Repositories(this.db),this.config)
    recoverCapabilityExtractions(this.repos)
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

  async beginAuthorization(input: { appKey: string; secretKey: string; appFolder: string }) {
    if (this.stopped) throw new Error('记忆服务已关闭。')
    if (this.pending) throw new Error('正在同步，请稍后连接。')
    const credentials = { appKey: input.appKey.trim(), secretKey: input.secretKey.trim(), appFolder: input.appFolder.trim() }
    if (!credentials.appKey || !credentials.secretKey || !credentials.appFolder || /[\/\\\x00-\x1f]/.test(credentials.appFolder) || ['.', '..'].includes(credentials.appFolder)) throw new Error('请填写有效的应用信息与应用目录名。')
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

  sync(): Promise<TransferStatus> {
    if (this.pending) return this.pending
    if (this.stopped || !this.db.isOpen) return Promise.resolve(this.status())
    this.pending = this.runSync().catch(error => {
      // Provider errors can contain query credentials; detailed raw errors never reach logs/UI.
      this.error = error instanceof PortableImportError && error.code === 'owner-mismatch'
        ? '云端与本机记忆属于不同主人，已停止合并。本地记忆已保留；新设备请先导入同一主人的记忆，再开始聊天。'
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
    const directory = `/apps/${credentials.appFolder}/dsh-companion-memory/${digest(this.config.companion.id).slice(0, 24)}`
    const ownPath = `${directory}/${digest(this.deviceId).slice(0, 24)}.companion.json`
    const files = await client.list(directory)
    for (const file of files.filter(file => file.name.endsWith('.companion.json')).sort((a, b) => Number(b.path === ownPath) - Number(a.path === ownPath) || a.modifiedAtMs - b.modifiedAtMs || a.path.localeCompare(b.path))) {
      if (this.stopped) return this.status()
      if (!file.path.startsWith(directory + '/') || basename(file.path) !== file.name || file.size > MAX_FILE_BYTES) throw new Error('invalid cloud snapshot')
      // Read current bytes even when mtime and size match: cloud timestamps can be coarse.
      const bytes = await client.download(file)
      if (this.stopped) return this.status()
      this.importBytes(bytes)
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
}
