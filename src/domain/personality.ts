import type { Config, PresetId } from '../config.js'
import type { Repositories } from '../storage/repositories.js'

export function personalityPreset(repos: Repositories, config: Config, principalId: string): PresetId {
  const role = repos.getSetting(`persona.id:${principalId}`)
  const selected = repos.getSetting(`personality.preset:${principalId}`)
    ?? repos.getSetting(`personality.default:${principalId}`)
    ?? (role === undefined || role === 'builtin' ? repos.getSetting('companion.preset') : undefined)
  return selected === 'balanced' || selected === 'gentle' || selected === 'irritable' ? selected : config.companion.preset
}
