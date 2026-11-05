/**
 * 设备—工作区台账（REQ-MOBILITY R2）。
 *
 * 只记路径、会话计数与时间；不记文件内容，也不记对话。
 * 合并口径：first_seen 取更早，last_seen 取更晚，session_count 两端累加。
 */

import type { Repositories } from './repositories.js'

export interface DeviceRecord {
  id: string
  name: string
  os: string
  osVersion: string | null
  firstSeenMs: number
  lastSeenMs: number
  metaJson: string | null
}

export interface WorkspaceRecord {
  deviceId: string
  cwd: string
  label: string | null
  firstSeenMs: number
  lastSeenMs: number
  sessionCount: number
  note: string | null
}

const MAX_CWD = 512

/** 只接受绝对路径形状，避免把空白或伪造串写成工作区。 */
export function normalizeCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_CWD) return null
  if (/[\u0000-\u001f]/.test(trimmed)) return null
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(trimmed)) return null
  return trimmed.replace(/[\\/]+$/, '') || trimmed
}

/** 宿主不同版本把工作目录放在不同字段，全部按可选读取。 */
export function sessionCwd(session: unknown): string | null {
  const rec = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const s = rec(session)
  const header = rec(s['header'])
  for (const candidate of [s['cwd'], s['workingDirectory'], s['workdir'], header['cwd'], header['workingDirectory']]) {
    const normalized = normalizeCwd(candidate)
    if (normalized) return normalized
  }
  return null
}

function toDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    os: String(row['os']),
    osVersion: row['os_version'] === null ? null : String(row['os_version']),
    firstSeenMs: Number(row['first_seen_ms']),
    lastSeenMs: Number(row['last_seen_ms']),
    metaJson: row['meta_json'] === null ? null : String(row['meta_json']),
  }
}

function toWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    deviceId: String(row['device_id']),
    cwd: String(row['cwd']),
    label: row['label'] === null ? null : String(row['label']),
    firstSeenMs: Number(row['first_seen_ms']),
    lastSeenMs: Number(row['last_seen_ms']),
    sessionCount: Number(row['session_count']),
    note: row['note'] === null ? null : String(row['note']),
  }
}

export interface DeviceInput {
  id: string
  name: string
  os: string
  release?: string
  arch?: string
}

/** 记录一次到访。同一台设备重复调用只推进 last_seen，不会重置 first_seen。 */
export function recordDeviceVisit(repos: Repositories, device: DeviceInput, cwd: string | null, nowMs: number): void {
  const meta = JSON.stringify({ arch: device.arch ?? null })
  repos.db.run(
    `INSERT INTO devices (id, name, os, os_version, first_seen_ms, last_seen_ms, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, os = excluded.os, os_version = excluded.os_version,
       first_seen_ms = MIN(devices.first_seen_ms, excluded.first_seen_ms),
       last_seen_ms = MAX(devices.last_seen_ms, excluded.last_seen_ms),
       meta_json = excluded.meta_json`,
    device.id, device.name, device.os, device.release ?? null, nowMs, nowMs, meta,
  )
  if (cwd !== null) recordWorkspaceVisit(repos, device.id, cwd, nowMs)
}

/** 会话级记录：设备尚未登记时什么都不写，由启动路径先登记设备。 */
export function recordWorkspaceVisit(repos: Repositories, deviceId: string, cwd: string | null, nowMs: number): void {
  const normalized = normalizeCwd(cwd)
  if (normalized === null) return
  if (getDevice(repos, deviceId) === null) return
  const label = normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized
  repos.db.run(
    `INSERT INTO device_workspaces (device_id, cwd, label, first_seen_ms, last_seen_ms, session_count, note)
     VALUES (?, ?, ?, ?, ?, 1, NULL)
     ON CONFLICT(device_id, cwd) DO UPDATE SET last_seen_ms = MAX(device_workspaces.last_seen_ms, excluded.last_seen_ms),
       session_count = device_workspaces.session_count + 1`,
    deviceId, normalized, label, nowMs, nowMs,
  )
}

export function listWorkspaces(repos: Repositories, deviceId: string): WorkspaceRecord[] {
  return repos.db
    .all<Record<string, unknown>>(
      'SELECT * FROM device_workspaces WHERE device_id = ? ORDER BY last_seen_ms DESC, cwd',
      deviceId,
    )
    .map(toWorkspace)
}

export function listDevices(repos: Repositories): DeviceRecord[] {
  return repos.db.all<Record<string, unknown>>('SELECT * FROM devices ORDER BY last_seen_ms DESC, id').map(toDevice)
}

export function getDevice(repos: Repositories, deviceId: string): DeviceRecord | null {
  const row = repos.db.get<Record<string, unknown>>('SELECT * FROM devices WHERE id = ?', deviceId)
  return row === undefined || row === null ? null : toDevice(row)
}

function stamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `/fish here` 的输出。当前设备排最前，其余设备只给一句摘要。 */
export function renderHereText(
  repos: Repositories,
  current: { id: string; name: string; os: string; release: string; arch: string; arrival: string; timezone: string },
  nowMs: number,
): string {
  const lines: string[] = []
  const known = getDevice(repos, current.id)
  const visited = known !== null
  lines.push(`当前电脑：${current.name}（${current.os} ${current.release} ${current.arch}）｜时区 ${current.timezone}`)
  lines.push(
    visited
      ? `来过：是，首次 ${stamp(known.firstSeenMs)}，上次 ${stamp(known.lastSeenMs)}`
      : '来过：这台电脑还没有记录（本次是第一次登记）',
  )
  const workspaces = listWorkspaces(repos, current.id)
  if (workspaces.length === 0) {
    lines.push('这台电脑上的工作区：暂无记录')
  } else {
    lines.push('这台电脑上的工作区：')
    for (const item of workspaces.slice(0, 12)) {
      lines.push(`  ${item.cwd}　${item.sessionCount} 次会话，最后 ${stamp(item.lastSeenMs)}`)
    }
    if (workspaces.length > 12) lines.push(`  …另有 ${workspaces.length - 12} 个`)
  }
  const others = listDevices(repos).filter((item) => item.id !== current.id)
  if (others.length === 0) {
    lines.push('另一端：暂无其它设备记录')
  } else {
    for (const other of others.slice(0, 5)) {
      lines.push(`另一端：${other.name}（${other.os}）最后活跃 ${stamp(other.lastSeenMs)}`)
    }
  }
  void nowMs
  return lines.join('\n')
}

/** 到达时的问候语按三态展开；`same` 保持原样，不打扰。 */
export function arrivalText(
  arrival: string,
  repos: Repositories,
  current: { id: string; name: string },
): string {
  if (arrival === 'new') {
    return '这是一台全新的电脑，我没有在这里的过去。要接上之前的历史，请先完成云同步或导入迁移包。'
  }
  if (arrival !== 'returned') return ''
  const known = getDevice(repos, current.id)
  const workspaces = listWorkspaces(repos, current.id)
  const head = `回到 ${current.name}（上次 ${stamp(known?.lastSeenMs ?? 0)}）。`
  if (workspaces.length === 0) return `${head}这台电脑上还没有登记过工作区。`
  const listed = workspaces.slice(0, 3).map((item) => item.cwd).join('；')
  return `${head}这台电脑上用过的工作区：${listed}${workspaces.length > 3 ? ` 等 ${workspaces.length} 个` : ''}。`
}
