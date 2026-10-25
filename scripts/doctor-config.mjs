import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load } from './vendor/js-yaml.mjs'

export function doctorConfig(args, home) {
  const index = args.indexOf('--config')
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('--config 需要 JSON/YAML 文件路径')
  const explicit = index >= 0
  const file = explicit ? resolve(args[index + 1]) : join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  if (!existsSync(file)) {
    if (explicit) throw new Error(`配置文件不存在：${file}`)
    return { raw: undefined, evidence: '默认配置（未找到 desktop profile）', defaults: true }
  }
  const parsed = load(readFileSync(file, 'utf8'))
  const row = Array.isArray(parsed) ? parsed.find(row => row?.id === 'dsh-companion-memory' || row?.name === 'dsh-companion-memory') : undefined
  if (Array.isArray(parsed) && !row) throw new Error(`Profile 未包含 dsh-companion-memory：${file}`)
  return { raw: Array.isArray(parsed) ? row.config : parsed, evidence: file, defaults: false }
}
