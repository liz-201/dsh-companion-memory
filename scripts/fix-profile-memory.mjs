#!/usr/bin/env node
/**
 * scripts/fix-profile-memory.mjs — 把「记忆」的职责钉死在本地插件上。
 *
 * 做什么：
 *  1. 从 profile 的 dsh.profile.bundles 摘掉需要云端凭据的外部记忆插件；
 *  2. 在 profile 的 cordis.patch.yml 落一行 `- id: <外部插件> disabled: true`（兜底，
 *     即使 bundles 被别的设备/别的工具加回来也不会加载）；
 *  3. 清掉 dsh-companion-memory 配置里写死的绝对路径（chatSessionsFile），
 *     回落到 dshHome() 推导的默认值，换机器/换用户名自动正确。
 *
 * 幂等：已经修好时什么都不写，退出码 0。改动前会备份成 <文件>.bak-memory-<时间戳>。
 *
 * 用法：
 *   node scripts/fix-profile-memory.mjs [--profile desktop] [--home <dsh home>] [--dry-run] [--json]
 */
import { applyProfileFixes, inspectProfile, resolveDshHome } from './profile-memory-guard.mjs'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const dryRun = args.includes('--dry-run')

function flag(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`)
  return value
}

function main() {
  const home = flag('--home', resolveDshHome())
  const profile = flag('--profile', 'desktop')
  const before = inspectProfile({ home, profile })
  const pending = before.findings.filter(finding => finding.level === 'warn' || finding.level === 'fail')

  const result = dryRun ? { changes: [], backups: [] } : applyProfileFixes({ home, profile, stamp: timestamp() })
  const after = inspectProfile({ home, profile })
  const remaining = after.findings.filter(finding => finding.level === 'warn' || finding.level === 'fail')

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({ home, profile, dryRun, before: before.findings, changes: result.changes, backups: result.backups, after: after.findings }, null, 2)}\n`)
  } else {
    process.stdout.write(`记忆职责守卫 · ${profile} · ${home}\n`)
    process.stdout.write(`${'─'.repeat(78)}\n`)
    for (const finding of before.findings) process.stdout.write(`${label(finding.level)}  ${finding.code.padEnd(24, ' ')} ${finding.detail}\n`)
    process.stdout.write(`${'─'.repeat(78)}\n`)
    if (dryRun) {
      process.stdout.write(pending.length === 0 ? '试运行：没有需要修的项目\n' : `试运行：有 ${pending.length} 项待修，去掉 --dry-run 才会写文件\n`)
    } else if (result.changes.length === 0) {
      process.stdout.write('没有需要修的项目（幂等）\n')
    } else {
      for (const change of result.changes) process.stdout.write(`已修  ${change}\n`)
      for (const file of result.backups) process.stdout.write(`备份  ${file}\n`)
      process.stdout.write('改的是 profile 配置：需要完全退出并重启 DSH 桌面端才会重新加载 loader。\n')
    }
    if (remaining.length > 0) {
      process.stdout.write(`仍有 ${remaining.length} 项未解决：\n`)
      for (const finding of remaining) process.stdout.write(`  ${finding.code}: ${finding.detail}${finding.fix ? `（${finding.fix}）` : ''}\n`)
    }
  }
  return remaining.length === 0 ? 0 : 1
}

function label(level) {
  return { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }[level] ?? level
}

function timestamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

process.exitCode = main()
