import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, platform, arch, release } from 'node:os'
import type { Repositories } from '../storage/repositories.js'

export function inspectDevice() {
  let identity = ''
  let reliable = true
  try {
    if (platform() === 'win32') {
      identity = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? ''
    } else if (platform() === 'linux') identity = readFileSync('/etc/machine-id', 'utf8').trim()
    else if (platform() === 'darwin') identity = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 }).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? ''
  } catch { /* Restricted hosts can still report a labelled fallback. */ }
  if (!identity) { identity = `${hostname()}:${platform()}:${arch()}`; reliable = false }
  return { id: createHash('sha256').update(`companion-device-v1:${identity}`).digest('hex').slice(0, 32), name: hostname(), os: platform(), release: release(), arch: arch(), reliable }
}

export function registerDevice(repos: Repositories, device = inspectDevice(), nowMs = Date.now()) {
  const key = `device.known:${device.id}`
  const known = repos.getSetting(key) !== undefined
  const previous = repos.getSetting('local.last-device')
  if (!known) repos.setSetting(key, JSON.stringify({ ...device, firstSeenAtMs: nowMs }), nowMs)
  repos.setSetting('local.device-id', device.id, nowMs)
  repos.setSetting('local.last-device', device.id, nowMs)
  const arrival = !known ? 'new' : previous !== device.id ? 'returned' : 'same'
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return { ...device, arrival, timezone, runtime: process.version, text: `当前电脑：${device.name}；${device.os} ${device.release} ${device.arch}；时区 ${timezone}；Node ${process.version}；${arrival === 'new' ? '第一次来到这台电脑' : arrival === 'returned' ? '回到了以前使用过的电脑' : '仍在熟悉的电脑上'}。${device.reliable ? '' : '设备识别使用主机名回退，改名后可能被视为新电脑。'}` }
}
