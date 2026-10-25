import type { Config } from '../config.js'
import type { Repositories } from '../storage/repositories.js'

export function companionInterests(repos: Repositories, config: Config, principalId: string): string[] {
  try {
    const saved = JSON.parse(repos.getSetting(`proactive.model-interests:${principalId}`) ?? 'null') as unknown
    if (Array.isArray(saved) && saved.every(value => typeof value === 'string')) return saved as string[]
  } catch { /* Invalid imported settings fall back to configured interests. */ }
  return config.proactive.modelInterests
}
