/**
 * scripts/profile-memory-guard.mjs — 记忆职责守卫。
 *
 * 背景：dsh-companion-memory 的记忆是本地 SQLite 权威，不需要任何云端凭据。
 * 但 profile 里一旦同时挂上「需要 token 的外部记忆插件」（例如
 * @vectorize-io/hindsight-coding-agents），它会在每轮/空闲时向自己的云端发请求；
 * 没配 token 就 401，既不产生记忆，还每轮往系统提示里塞几千字符的工具说明。
 *
 * 换设备、重建 profile、从别的机器拷配置，都可能把这个外部插件带回来。所以把
 * 「检查 + 修复」抽成纯函数：doctor 只读检查，fix 脚本执行修复，两边共用一套判定。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** 已知的外部记忆插件：bundle 名 → loader 里对应的 id。 */
export const EXTERNAL_MEMORY_BUNDLES = [
  { bundle: '@vectorize-io/hindsight-coding-agents', id: 'hindsight' },
]

/** 本插件在 loader 里的 id。 */
export const COMPANION_ID = 'dsh-companion-memory'

export function resolveDshHome(env = process.env) {
  const value = env['DSH_HOME']
  return value !== undefined && value !== '' ? value : join(homedir(), '.dsh')
}

export function profilePaths(home, profile) {
  const dir = join(home, 'profiles', profile)
  return { dir, packageFile: join(dir, 'package.json'), patchFile: join(dir, 'cordis.patch.yml') }
}

/** 顶层 YAML 数组条目：以 `- ` 开头（列 0），到下一个同类条目或文件结束。 */
export function topLevelBlocks(lines) {
  const starts = []
  lines.forEach((line, index) => {
    if (/^-\s/.test(line)) starts.push(index)
  })
  return starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? starts[index + 1] : lines.length,
  }))
}

export function findRow(lines, id) {
  const pattern = new RegExp(`^-\\s*id:\\s*['"]?${id}['"]?\\s*$`)
  const block = topLevelBlocks(lines).find(candidate => pattern.test(lines[candidate.start]))
  if (!block) return null
  return { ...block, body: lines.slice(block.start + 1, block.end) }
}

function rowDisabled(lines, id) {
  const row = findRow(lines, id)
  return row !== null && row.body.some(line => /^\s*disabled:\s*true\s*$/.test(line))
}

function splitLines(text) {
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', lines: text.split(/\r?\n/) }
}

function readText(file) {
  const text = readFileSync(file, 'utf8')
  return { text, ...splitLines(text) }
}

function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '').trim()
}

function chatSessionsValue(line) {
  return unquote(line.replace(/^\s*chatSessionsFile:\s*/, ''))
}

function readBundles(file, findings) {
  if (!existsSync(file)) {
    findings.push({ level: 'warn', code: 'profile-missing', detail: '找不到 profile 的 package.json，无法判断记忆插件归属', file })
    return []
  }
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  } catch (error) {
    findings.push({ level: 'fail', code: 'profile-json', detail: `profile package.json 解析失败：${error?.message ?? error}`, file })
    return []
  }
}

/**
 * 只读检查：返回 findings，不改任何文件。
 * level=ok 表示这一项符合「记忆只走本地」；warn 表示存在可修的隐患。
 */
export function inspectProfile({ home = resolveDshHome(), profile = 'desktop' } = {}) {
  const { packageFile, patchFile } = profilePaths(home, profile)
  const findings = []
  const bundles = readBundles(packageFile, findings)
  const patch = existsSync(patchFile) ? readText(patchFile) : null

  if (!patch) {
    findings.push({ level: 'warn', code: 'patch-missing', detail: '找不到 profile 的 cordis.patch.yml，无法确认外部记忆插件已被关闭', file: patchFile })
  }

  for (const entry of EXTERNAL_MEMORY_BUNDLES) {
    const listed = bundles.includes(entry.bundle)
    const disabled = patch !== null && rowDisabled(patch.lines, entry.id)
    if (listed && !disabled) {
      findings.push({
        level: 'warn',
        code: 'external-memory-active',
        detail: `外部记忆插件 ${entry.bundle} 已挂载且未禁用：没配云端 token 时它只会 401，记忆职责应由本地插件独占`,
        file: packageFile,
        fix: `node scripts/fix-profile-memory.mjs --profile ${profile}`,
      })
    } else if (listed) {
      findings.push({
        level: 'ok',
        code: 'external-memory-disabled',
        detail: `外部记忆插件 ${entry.bundle} 仍在 bundles 里，但 loader 行 id=${entry.id} 已 disabled: true`,
        file: patchFile,
      })
    } else {
      findings.push({
        level: 'ok',
        code: 'external-memory-absent',
        detail: `bundles 未包含外部记忆插件 ${entry.bundle}`,
        file: packageFile,
      })
    }
  }

  if (patch) {
    const row = findRow(patch.lines, COMPANION_ID)
    if (!row) {
      findings.push({ level: 'warn', code: 'companion-row-missing', detail: `cordis.patch.yml 里没有 id=${COMPANION_ID} 的顶层配置行`, file: patchFile })
    } else {
      const line = row.body.find(candidate => /^\s*chatSessionsFile:/.test(candidate))
      const value = line === undefined ? '' : chatSessionsValue(line)
      if (value !== '' && isAbsolute(value)) {
        findings.push({
          level: 'warn',
          code: 'absolute-session-path',
          detail: `chatSessionsFile 写死了绝对路径 ${value}：换设备/换用户名会指向不存在的文件，删掉该行即可回落到 dshHome() 推导的默认值`,
          file: patchFile,
          fix: `node scripts/fix-profile-memory.mjs --profile ${profile}`,
        })
      }
    }
  }

  return { home, profile, packageFile, patchFile, bundles, findings }
}

/**
 * 修复：把外部记忆插件从 bundles 摘掉、在 patch 里落一行 disabled、清掉写死的绝对路径。
 * 幂等：已经符合预期时返回空 changes。
 */
export function applyProfileFixes({ home = resolveDshHome(), profile = 'desktop', stamp = 'manual' } = {}) {
  const { packageFile, patchFile } = profilePaths(home, profile)
  const changes = []
  const backups = []
  // 摘除前先记下当前挂载了哪些外部记忆插件：只有真挂载过、或 patch 里已有该行的
  // profile 才写 disabled，干净的 profile 一个字都不动。
  const listed = new Set(existsSync(packageFile) ? readBundles(packageFile, []) : [])

  if (existsSync(packageFile)) {
    const { eol, lines } = readText(packageFile)
    const kept = lines.filter(line => {
      const hit = EXTERNAL_MEMORY_BUNDLES.some(entry =>
        new RegExp(`^\\s*"${entry.bundle.replace(/[/\\]/g, '\\$&')}",?\\s*$`).test(line))
      return !hit
    })
    if (kept.length !== lines.length) {
      const repaired = repairTrailingCommas(kept)
      backups.push(backup(packageFile, stamp))
      writeFileSync(packageFile, repaired.join(eol), 'utf8')
      changes.push(`从 dsh.profile.bundles 移除外部记忆插件（${lines.length - kept.length} 行）：${packageFile}`)
    }
  }

  if (existsSync(patchFile)) {
    const { eol, lines } = readText(patchFile)
    const next = [...lines]
    let touched = false

    for (const entry of EXTERNAL_MEMORY_BUNDLES) {
      if (rowDisabled(next, entry.id)) continue
      const row = findRow(next, entry.id)
      if (row) {
        const offset = row.body.findIndex(line => /^\s*disabled:/.test(line))
        if (offset >= 0) next[row.start + 1 + offset] = '  disabled: true'
        else next.splice(row.start + 1, 0, '  disabled: true')
      } else {
        if (!listed.has(entry.bundle)) continue
        while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
        next.push(
          '',
          '# 外部记忆插件需要云端 token；没配就只会 401，还把无关工具说明塞进每轮提示。',
          '# 记忆权威是本地 dsh-companion-memory（SQLite），这一行保证换设备也不会把它挂回来。',
          `- id: ${entry.id}`,
          '  disabled: true',
          '',
        )
      }
      touched = true
      changes.push(`在 cordis.patch.yml 落 id=${entry.id} disabled: true：${patchFile}`)
    }

    const row = findRow(next, COMPANION_ID)
    if (row) {
      const offset = row.body.findIndex(line => /^\s*chatSessionsFile:/.test(line) && isAbsolute(chatSessionsValue(line)))
      if (offset >= 0) {
        next[row.start + 1 + offset] = '  # chatSessionsFile 不写：默认 join(dshHome(), "media", "onebot", "chat-sessions.json")，跨设备自动正确'
        touched = true
        changes.push(`注释掉写死的 chatSessionsFile，回落到 dshHome() 默认推导：${patchFile}`)
      }
    }

    if (touched) {
      backups.push(backup(patchFile, stamp))
      writeFileSync(patchFile, next.join(eol), 'utf8')
    }
  }

  return { changes, backups }
}

function backup(file, stamp) {
  const target = `${file}.bak-memory-${stamp}`
  copyFileSync(file, target)
  return target
}

/** 删掉数组/对象最后一项后，前一行可能留下尾随逗号，JSON 就废了。这里补回来。 */
function repairTrailingCommas(lines) {
  const next = [...lines]
  for (let index = 0; index < next.length - 1; index += 1) {
    if (!/,\s*$/.test(next[index])) continue
    let lookahead = index + 1
    while (lookahead < next.length && next[lookahead].trim() === '') lookahead += 1
    if (lookahead < next.length && /^\s*[\]}]/.test(next[lookahead])) next[index] = next[index].replace(/,\s*$/, '')
  }
  return next
}
