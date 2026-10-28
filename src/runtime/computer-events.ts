import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { cpus, freemem, networkInterfaces, totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'

/** 采集开关由控制台配置提供；本模块默认不启用。 */
export interface ComputerEventsSettings {
  enabled: boolean
  pollSeconds: number
  idleThresholdSeconds: number
  foregroundApplications: boolean
  resources: boolean
  network: boolean
  watchDirectories: string[]
}

export interface ComputerEvent {
  id: string
  kind: 'idle_return' | 'foreground_app_changed' | 'network_restored' | 'battery_low' | 'resource_pressure' | 'file_changed' | 'interface_observed'
  occurredAtMs: number
  summary: string
  details: Record<string, string | number | boolean | null>
}

export interface ComputerSnapshot {
  notificationState?: 'accepts' | 'blocked' | 'unknown'
  sampledAtMs: number
  idleSeconds: number | null
  foregroundApp: string | null
  networkOnline: boolean | null
  batteryPercent: number | null
  cpuPercent: number | null
  memoryPercent: number | null
}

export interface ComputerEventsStatus {
  running: boolean
  sampling: boolean
  supported: boolean
  lastSampleAtMs: number | null
  error: string | null
  snapshot: ComputerSnapshot | null
  watchingDirectories: number
  unavailableDirectories: string[]
}

export interface ComputerEventsOptions {
  onSample?: (snapshot:ComputerSnapshot)=>void
  settings: () => ComputerEventsSettings
  onEvent: (event: ComputerEvent) => void
  readSnapshot?: () => Promise<ComputerSnapshot>
  now?: () => number
}

const RECENT_LIMIT = 30
const PROBE_TIMEOUT_MS = 4000
const CPU_PRESSURE_PERCENT = 85
const CPU_RELEASE_PERCENT = 70
const MEMORY_PRESSURE_PERCENT = 90
const MEMORY_RELEASE_PERCENT = 80
const BATTERY_LOW_PERCENT = 20
const BATTERY_RELEASE_PERCENT = 30
const FILE_DEBOUNCE_MS = 1500
const NOISE_SEGMENTS = new Set(['.git', '.svn', 'node_modules', 'credentials', '.ssh', '.gnupg', 'artifacts', 'dist', 'lib'])
const NOISE_FILES = /^(\.env(\..*)?|credentials(\..*)?|id_rsa(\..*)?|id_ed25519(\..*)?|baidu\.json|.*\.(pem|key|p12|pfx|kdbx))$/i

const ERROR_UNAVAILABLE = '电脑事件探针不可用'
const ERROR_TIMEOUT = '系统查询超时'
const ERROR_QUERY = '系统查询失败'

/** 固定脚本：只读空闲时长与前台进程名，不含窗口标题，不接受外部参数拼入。 */
const WINDOWS_PROBE = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class DshComputerProbe {',
  '  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);',
  '  public static string NotificationState() { int state; if(SHQueryUserNotificationState(out state)!=0)return "unknown";return state==5 ? "accepts" : "blocked"; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  '  public static double IdleSeconds() {',
  '    LASTINPUTINFO info = new LASTINPUTINFO();',
  '    info.cbSize = (uint)Marshal.SizeOf(info);',
  '    if (!GetLastInputInfo(ref info)) { return -1; }',
  '    uint elapsed = unchecked((uint)Environment.TickCount - info.dwTime);',
  '    return elapsed / 1000.0;',
  '  }',
  '  public static string ForegroundProcess() {',
  '    IntPtr handle = GetForegroundWindow();',
  '    if (handle == IntPtr.Zero) { return ""; }',
  '    uint processId;',
  '    GetWindowThreadProcessId(handle, out processId);',
  '    if (processId == 0) { return ""; }',
  '    try { return System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; } catch { return ""; }',
  '  }',
  '}',
  "'@",
  '$battery = (Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1).EstimatedChargeRemaining',
  '@{ idle = [DshComputerProbe]::IdleSeconds(); app = [DshComputerProbe]::ForegroundProcess(); battery = $battery; notification = [DshComputerProbe]::NotificationState() } | ConvertTo-Json -Compress'
].join('\n')

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function isNoisePath(name: string, noisySegments: Set<string>): boolean {
  if (!name) return true
  if (NOISE_FILES.test(name)) return true
  return noisySegments.has(name)
}

/** 只保留安全的标量字段，避免把命令输出原样带到上层。 */
function scalar(value: string | number | boolean | null | undefined): string | number | boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return String(value)
}

function networkOnline(): boolean | null {
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.internal) continue
        if (address.family === 'IPv4' || address.family === 'IPv6') return true
      }
    }
    return false
  } catch { return null }
}

type ProbeData = Pick<ComputerSnapshot,'idleSeconds'|'foregroundApp'|'batteryPercent'|'notificationState'>
function parseProbe(stdout: string): ProbeData {
  const line = stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean).pop()
  if (!line) throw new Error('empty')
  const raw = JSON.parse(line) as Record<string, unknown>
  const idle = typeof raw['idle'] === 'number' && Number.isFinite(raw['idle']) && raw['idle'] >= 0 ? Math.round(raw['idle']) : null
  const app = typeof raw['app'] === 'string' && raw['app'].trim() ? raw['app'].trim().slice(0, 80) : null
  const batteryRaw = raw['battery']
  const battery = typeof batteryRaw === 'number' && Number.isFinite(batteryRaw) && batteryRaw >= 0 && batteryRaw <= 100 ? Math.round(batteryRaw) : null
  const notificationState: NonNullable<ComputerSnapshot['notificationState']> = raw['notification']==='accepts'?'accepts':raw['notification']==='blocked'?'blocked':'unknown'
  return { idleSeconds: idle, foregroundApp: app, batteryPercent: battery, notificationState }
}

function windowsProbe(settings: ComputerEventsSettings): Promise<ProbeData> {
  // Flags only select fixed expressions; no path or user input is interpolated into a command.
  const script = WINDOWS_PROBE.replace('[DshComputerProbe]::ForegroundProcess()', settings.foregroundApplications ? '[DshComputerProbe]::ForegroundProcess()' : '$null')
    .replace('$battery = (Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1).EstimatedChargeRemaining', settings.resources ? '$battery = (Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1).EstimatedChargeRemaining' : '$battery = $null')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
          reject(Object.assign(new Error(timedOut ? ERROR_TIMEOUT : ERROR_QUERY), { code: timedOut ? 'timeout' : 'query' }))
          return
        }
        try { resolve(parseProbe(stdout)) } catch { reject(Object.assign(new Error(ERROR_QUERY), { code: 'query' })) }
      })
  })
}

/**
 * 纯函数：给定前后两次快照与设置，算出该发的边沿事件。
 * 首次采样（previous 为 null）只是基线，永远不产生事件。
 */
export function deriveEvents(previous: ComputerSnapshot | null, next: ComputerSnapshot, settings: ComputerEventsSettings, state: IdleState): ComputerEvent[] {
  if (!previous) {
    state.batteryLow = next.batteryPercent !== null && next.batteryPercent <= BATTERY_LOW_PERCENT
    state.resourcePressure = (next.cpuPercent !== null && next.cpuPercent >= CPU_PRESSURE_PERCENT) || (next.memoryPercent !== null && next.memoryPercent >= MEMORY_PRESSURE_PERCENT)
    return []
  }
  const events: ComputerEvent[] = []
  const at = next.sampledAtMs
  const threshold = clamp(settings.idleThresholdSeconds, 5, 86_400, 300)
  const emit = (kind: ComputerEvent['kind'], summary: string, details: Record<string, string | number | boolean | null>): void => {
    events.push({ id: randomUUID(), kind, occurredAtMs: at, summary, details })
  }
  if (settings.foregroundApplications) {
    const before = previous.foregroundApp
    const after = next.foregroundApp
    if (before !== null && after !== null && before !== after) {
      emit('foreground_app_changed', `前台应用切换到 ${after}`, { previous: before, current: after })
    }
  }
  if (previous.idleSeconds !== null && next.idleSeconds !== null) {
    // 必须是“确实检测到输入”的下降，不能拿两次采样的时间差冒充唤醒。
    if (previous.idleSeconds >= threshold && next.idleSeconds < threshold) {
      emit('idle_return', '检测到键盘鼠标活动恢复', { idleSeconds: next.idleSeconds, thresholdSeconds: threshold })
    }
  }
  if (settings.network && previous.networkOnline === false && next.networkOnline === true) {
    emit('network_restored', '本机网卡连接已恢复（未验证互联网可达）', { online: true })
  }
  if (settings.resources && next.batteryPercent !== null) {
    const wasLow = state.batteryLow
    if (!wasLow && next.batteryPercent <= BATTERY_LOW_PERCENT) {
      state.batteryLow = true
      emit('battery_low', `电量偏低：${next.batteryPercent}%`, { batteryPercent: next.batteryPercent, threshold: BATTERY_LOW_PERCENT })
    } else if (wasLow && next.batteryPercent >= BATTERY_RELEASE_PERCENT) {
      state.batteryLow = false
    }
  }
  if (settings.resources) {
    const cpu = next.cpuPercent
    const memory = next.memoryPercent
    const underPressure = (cpu !== null && cpu >= CPU_PRESSURE_PERCENT) || (memory !== null && memory >= MEMORY_PRESSURE_PERCENT)
    const released = (cpu === null || cpu <= CPU_RELEASE_PERCENT) && (memory === null || memory <= MEMORY_RELEASE_PERCENT)
    if (!state.resourcePressure && underPressure) {
      state.resourcePressure = true
      emit('resource_pressure', '系统资源紧张', { cpuPercent: scalar(cpu), memoryPercent: scalar(memory) })
    } else if (state.resourcePressure && released) {
      state.resourcePressure = false
    }
  }
  return events
}

export interface IdleState {
  batteryLow: boolean
  resourcePressure: boolean
}

/**
 * Windows 电脑事件采集：只读空闲时长、前台进程名、系统资源与网络，以及显式目录的文件变化。
 * 不读窗口标题、屏幕、剪贴板、键盘、文件内容或浏览历史；默认不启用。
 */
export class ComputerEvents {
  private readonly settings: () => ComputerEventsSettings
  private readonly onEvent: (event: ComputerEvent) => void
  private readonly onSample?: (snapshot:ComputerSnapshot)=>void
  private readonly readSnapshot: () => Promise<ComputerSnapshot>
  private readonly now: () => number
  private recentEvents: ComputerEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private watchers = new Map<string, FSWatcher>()
  private debounce = new Map<string, number>()
  private cpuSample: { idle: number; total: number } | null = null
  private lastSnapshot: ComputerSnapshot | null = null
  private state: IdleState = { batteryLow: false, resourcePressure: false }
  private running = false
  private sampling = false
  private generation = 0
  private lastSampleAtMs: number | null = null
  private error: string | null = null
  private unavailableDirectories: string[] = []

  constructor(options: ComputerEventsOptions) {
    this.settings = options.settings
    this.onEvent = options.onEvent
    this.onSample = options.onSample
    this.now = options.now ?? (() => Date.now())
    this.readSnapshot = options.readSnapshot ?? (() => this.probe())
  }

  get supported(): boolean { return process.platform === 'win32' }

  start(): void {
    if (this.running) return
    if (!this.settings().enabled) return
    this.running = true
    this.generation += 1
    this.lastSnapshot = null
    this.state = { batteryLow: false, resourcePressure: false }
    this.syncWatchers()
    this.scheduleNext(0)
  }

  stop(): void {
    this.running = false
    this.generation += 1
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const watcher of this.watchers.values()) { try { watcher.close() } catch { /* 关闭失败不影响停止 */ } }
    this.watchers.clear()
    this.debounce.clear()
    this.lastSnapshot = null
    this.cpuSample = null
  }

  status(): ComputerEventsStatus {
    return {
      running: this.running,
      sampling: this.sampling,
      supported: this.supported,
      lastSampleAtMs: this.lastSampleAtMs,
      error: this.error,
      snapshot: this.lastSnapshot,
      watchingDirectories: this.watchers.size,
      unavailableDirectories: [...this.unavailableDirectories],
    }
  }

  recent(): ComputerEvent[] { return this.recentEvents.slice(-RECENT_LIMIT) }

  async sample(): Promise<ComputerSnapshot | null> {
    if (!this.settings().enabled || this.sampling) return null
    const generation = this.generation
    this.sampling = true
    try {
      const read = await this.readSnapshot()
      // 非 Windows 平台仍返回 Node 可得的资源/网络，但 Windows 专属探针一律为 null 并明确标注不可用。
      this.error = this.supported ? null : ERROR_UNAVAILABLE
      // 卸载或开关关闭后：飞行结果不再产生事件，也不再更新基线。
      if (generation !== this.generation) return null
      const settings = this.settings()
      if (!settings.enabled) return null
      const snapshot: ComputerSnapshot = { ...read,
        foregroundApp: settings.foregroundApplications ? read.foregroundApp : null,
        networkOnline: settings.network ? read.networkOnline : null,
        batteryPercent: settings.resources ? read.batteryPercent : null,
        cpuPercent: settings.resources ? read.cpuPercent : null,
        memoryPercent: settings.resources ? read.memoryPercent : null,
      }
      const events = deriveEvents(this.lastSnapshot, snapshot, settings, this.state)
      this.lastSnapshot = snapshot
      this.lastSampleAtMs = snapshot.sampledAtMs
      this.onSample?.(snapshot)
      for (const event of events) this.emit(event)
      return snapshot
    } catch (error) {
      if (generation !== this.generation || !this.settings().enabled) return null
      const message = (error as { message?: string }).message ?? ''
      this.error = message === ERROR_TIMEOUT ? ERROR_TIMEOUT : ERROR_QUERY
      return null
    } finally {
      this.sampling = false
    }
  }

  private emit(event: ComputerEvent): void {
    if (!this.settings().enabled) return
    this.recentEvents.push(event)
    if (this.recentEvents.length > RECENT_LIMIT) this.recentEvents = this.recentEvents.slice(-RECENT_LIMIT)
    try { this.onEvent(event) } catch { /* 回调失败不能拖垮采集 */ }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    const settings = this.settings()
    if (!settings.enabled) { this.stop(); return }
    this.syncWatchers()
    if (!this.sampling) await this.sample()
    this.scheduleNext(clamp(settings.pollSeconds, 1, 3600, 60) * 1000)
  }

  private syncWatchers(): void {
    const settings = this.settings()
    this.unavailableDirectories = []
    const wanted = new Set(settings.watchDirectories.filter(path => typeof path === 'string' && path.trim() !== '' && isAbsolute(path)))
    for (const [path, watcher] of [...this.watchers]) {
      if (wanted.has(path)) continue
      try { watcher.close() } catch { /* 忽略关闭错误 */ }
      this.watchers.delete(path)
    }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue
      const segments = path.split(/[\\/]+/).map(segment => segment.toLowerCase())
      if (segments.some(segment => NOISE_SEGMENTS.has(segment))) { this.unavailableDirectories.push(basename(path)); continue }
      try {
        const watcher = watch(path, { persistent: false, recursive: false }, (_event, name) => this.onFile(path, name === null ? '' : String(name)))
        watcher.on('error', () => { try { watcher.close() } catch { /* 忽略 */ } this.watchers.delete(path); this.unavailableDirectories.push(basename(path)) })
        this.watchers.set(path, watcher)
      } catch { this.unavailableDirectories.push(basename(path)) }
    }
  }

  private onFile(directory: string, name: string): void {
    if (!this.running) return
    const settings = this.settings()
    if (!settings.enabled) return
    const file = basename(name)
    if (isNoisePath(file, NOISE_SEGMENTS)) return
    const key = `${directory.toLowerCase()}|${file.toLowerCase()}`
    const at = this.now()
    const previous = this.debounce.get(key) ?? 0
    if (at - previous < FILE_DEBOUNCE_MS) return
    this.debounce.set(key, at)
    if (this.debounce.size > 1000) for (const [item, time] of this.debounce) { if (at - time >= FILE_DEBOUNCE_MS) this.debounce.delete(item) }
    this.emit({
      id: randomUUID(),
      kind: 'file_changed',
      occurredAtMs: at,
      summary: `目录内文件有变化：${file}`,
      details: { directory: basename(directory), file }
    })
  }

  private async probe(): Promise<ComputerSnapshot> {
    const sampledAtMs = this.now()
    const settings = this.settings()
    const memoryPercent = (() => {
      if (!settings.resources) return null
      try {
        const total = totalmem()
        if (!Number.isFinite(total) || total <= 0) return null
        return Math.round(((total - freemem()) / total) * 100)
      } catch { return null }
    })()
    const cpuPercent = (() => {
      if (!settings.resources) return null
      try {
        let idle = 0
        let total = 0
        for (const cpu of cpus()) {
          for (const value of Object.values(cpu.times)) total += value
          idle += cpu.times.idle
        }
        const previous = this.cpuSample
        this.cpuSample = { idle, total }
        if (!previous) return null
        const deltaTotal = total - previous.total
        const deltaIdle = idle - previous.idle
        if (deltaTotal <= 0) return null
        return Math.min(100, Math.max(0, Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 100)))
      } catch { return null }
    })()
    const online = settings.network ? networkOnline() : null
    let idleSeconds: number | null = null
    let foregroundApp: string | null = null
    let batteryPercent: number | null = null
    let notificationState:NonNullable<ComputerSnapshot['notificationState']>='unknown'
    if (process.platform === 'win32') {
      const result = await windowsProbe(settings)
      idleSeconds = result.idleSeconds
      foregroundApp = result.foregroundApp
      batteryPercent = result.batteryPercent
      notificationState = result.notificationState??'unknown'
    }
    return { sampledAtMs, idleSeconds, foregroundApp, networkOnline: online, batteryPercent, cpuPercent, memoryPercent,notificationState }
  }
}
