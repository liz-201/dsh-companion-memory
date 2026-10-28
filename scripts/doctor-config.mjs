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
  if (Array.isArray(parsed) && !row) {
    const manifestFile = join(home, 'profiles', 'desktop', 'package.json')
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
    const bundles = manifest.dsh?.profile?.bundles
    const removed = parsed.some(item => item?.remove === 'dsh-companion-memory' || Array.isArray(item?.remove) && item.remove.includes('dsh-companion-memory'))
    if (!explicit && !removed && Array.isArray(bundles) && bundles.includes('dsh-companion-memory')) {
      return { raw: undefined, evidence: `${manifestFile} 的 bundle 默认配置（无 profile 覆盖）`, defaults: false }
    }
    throw new Error(`Profile 未包含已启用的 dsh-companion-memory：${file}`)
  }
  return { raw: Array.isArray(parsed) ? row.config : parsed, evidence: file, defaults: false }
}
