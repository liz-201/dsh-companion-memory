#!/usr/bin/env node
/**
 * scripts/doctor.mjs — 只读自检（规格 §16.3）。
 *
 * 设计约束：
 *  - 只读：不建库、不迁移、不写审计、不改任何状态。数据库以 readOnly 打开，
 *    文件不存在时只报 WARN，不会创建它。
 *  - 每一项都给出可复现的证据（路径、PRAGMA 结果、计数），失败项返回退出码 1。
 *
 * 用法：node scripts/doctor.mjs [--json]
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const jsonOut = process.argv.includes('--json')

const checks = []
function add(level, name, detail, evidence) {
  checks.push({ level, name, detail, evidence })
}

async function main() {
  const { resolveConfig, dshHome, DEFAULT_CONFIG } = await import('../lib/config.js')
  const { databaseFile, databaseExists } = await import('../lib/storage/database.js')

  // 1) 配置可解析（坏配置必须在这里就暴露，而不是等运行时）
  let config
  try {
    config = resolveConfig(undefined)
    add('ok', '配置解析', `companion=${config.companion.id} preset=${config.companion.preset}`, 'resolveConfig(undefined)')
  } catch (error) {
    add('fail', '配置解析', String(error?.message ?? error), 'resolveConfig(undefined)')
    return report()
  }

  // 2) 运行环境
  const [major, minor] = process.versions.node.split('.').map(Number)
  const nodeOk = major > 22 || (major === 22 && minor >= 13)
  add(nodeOk ? 'ok' : 'fail', 'Node 版本', `${process.versions.node}（要求 >=22.13，node:sqlite 内置）`, 'process.versions.node')

  let sqliteOk = false
  try {
    const { DatabaseSync } = await import('node:sqlite')
    sqliteOk = typeof DatabaseSync === 'function'
  } catch { /* 下面统一报 */ }
  add(sqliteOk ? 'ok' : 'fail', 'node:sqlite', sqliteOk ? '可用' : '不可用（本插件没有可用的持久化后端）', 'import("node:sqlite")')

  // 3) 提示词文件（缺一个就等于人设/协议不完整）
  for (const name of ['persona-irritable.txt', 'persona-balanced.txt', 'persona-gentle.txt', 'protocol.txt', 'consolidate.txt']) {
    const file = join(root, 'prompts', name)
    const exists = existsSync(file)
    const size = exists ? statSync(file).size : 0
    add(exists && size > 0 ? 'ok' : 'fail', `提示词 ${name}`, exists ? `${size} 字节` : '缺失', file)
  }

  // 4) 数据库
  const dir = config.storage.directory.startsWith('~')
    ? join(dshHome(), config.storage.directory.slice(1))
    : config.storage.directory
  const file = databaseFile(dir, config.companion.id)
  if (!databaseExists(file)) {
    add('warn', '数据库', '尚未创建（插件首次启动时自动建立）', file)
    add('warn', '完整性检查', '跳过（数据库不存在）', file)
    add('warn', '迁移版本', '跳过（数据库不存在）', file)
  } else {
    add('ok', '数据库', `${statSync(file).size} 字节`, file)
    const { DatabaseSync } = await import('node:sqlite')
    let db
    try {
      db = new DatabaseSync(file, { readOnly: true })
      const integrity = db.prepare('PRAGMA integrity_check').get()
      const value = integrity ? Object.values(integrity)[0] : 'unknown'
      add(value === 'ok' ? 'ok' : 'fail', '完整性检查', String(value), 'PRAGMA integrity_check')
      const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      const latest = applied.length > 0 ? String(applied[applied.length - 1].version) : 'none'
      add(applied.length > 0 ? 'ok' : 'fail', '迁移版本', `已应用 ${applied.length} 个，最新 ${latest}`, 'schema_migrations')
      const fts = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'memories_fts%'").all()
      add(fts.length > 0 ? 'ok' : 'warn', 'FTS5 索引', fts.length > 0 ? `${fts.length} 个对象` : '缺失（退化为 LIKE 检索）', "sqlite_master LIKE 'memories_fts%'")
      for (const [label, sql] of [
        ['记忆条数', 'SELECT COUNT(*) AS n FROM memories'],
        ['原文条数', 'SELECT COUNT(*) AS n FROM raw_messages'],
        ['待发 outbox', "SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending','sending','unknown')"],
        ['未完成任务', "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('proposed','confirmed','due')"],
        ['背景任务积压', "SELECT COUNT(*) AS n FROM background_jobs WHERE status IN ('queued','running')"]
      ]) {
        try {
          const row = db.prepare(sql).get()
          add('ok', label, String(row?.n ?? 0), sql)
        } catch (error) {
          add('warn', label, `查询失败：${String(error?.message ?? error)}`, sql)
        }
      }
    } catch (error) {
      add('fail', '数据库打开', String(error?.message ?? error), file)
    } finally {
      try { db?.close() } catch { /* 忽略 */ }
    }
  }

  // 5) 通道（QQ 桥）
  const sessionsFile = config.channel.chatSessionsFile
  const sessionsOk = typeof sessionsFile === 'string' && existsSync(sessionsFile)
  add(sessionsOk ? 'ok' : 'warn', 'chat-sessions 映射', sessionsOk ? sessionsFile : '未找到（QQ 侧会话定位不可用）', String(sessionsFile))
  const owners = config.channel.ownerChats ?? []
  add(owners.length > 0 ? 'ok' : 'warn', 'owner 会话白名单', owners.length > 0 ? owners.join(', ') : '为空（不主动发消息）', 'config.channel.ownerChats')

  // 6) 备份
  const backupDir = join(dir, 'backups')
  if (!existsSync(backupDir)) {
    add('warn', '备份', '尚无备份目录', backupDir)
  } else {
    const files = readdirSync(backupDir).filter((name) => name.endsWith('.db'))
    add(files.length > 0 ? 'ok' : 'warn', '备份', `${files.length} 个文件`, backupDir)
  }

  // 7) 编译产物是否落后于源码（doctor 只读，不自动重建）
  const srcTs = countFiles(join(root, 'src'), '.ts')
  const libJs = countFiles(join(root, 'lib'), '.js')
  add(libJs >= srcTs ? 'ok' : 'warn', '编译产物', `src ${srcTs} 个 .ts / lib ${libJs} 个 .js`, join(root, 'lib'))

  return report()
}

function countFiles(dir, suffix) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name), suffix)
    else if (entry.name.endsWith(suffix)) n += 1
  }
  return n
}

function report() {
  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), checks, fails, warns }, null, 2)}\n`)
  } else {
    const label = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }
    process.stdout.write(`doctor · ${DEFAULT_LABEL()}\n`)
    process.stdout.write(`${'─'.repeat(78)}\n`)
    for (const check of checks) {
      process.stdout.write(`${label[check.level]}  ${check.name.padEnd(16, ' ')} ${check.detail}\n`)
      if (check.level !== 'ok' && check.evidence) process.stdout.write(`${' '.repeat(6)}证据：${check.evidence}\n`)
    }
    process.stdout.write(`${'─'.repeat(78)}\n`)
    process.stdout.write(`合计 ${checks.length} 项：失败 ${fails} · 警告 ${warns} · 通过 ${checks.length - fails - warns}\n`)
    process.stdout.write(fails === 0 ? '结论：可启动（警告项为可选能力或首次运行状态）\n' : '结论：存在阻断项，请按上面证据修复后再启动\n')
  }
  return fails === 0 ? 0 : 1
}

function DEFAULT_LABEL() {
  return `${process.platform} node ${process.versions.node}`
}

const code = await main()
process.exitCode = code
