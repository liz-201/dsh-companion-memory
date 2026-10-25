import { createHash } from 'node:crypto'
import type { Personality } from './types.js'

export const TRAITS = ['irritability', 'sensitivity', 'directness', 'selfControl', 'warmth', 'initiative', 'socialEnergy', 'playfulness', 'reserve', 'conscientiousness', 'curiosity', 'optimism'] as const
export type Trait = typeof TRAITS[number]
export type Traits = Record<Trait, number>
export const NEUTRAL: Traits = { irritability: .4, sensitivity: .45, directness: .6, selfControl: .65, warmth: .6, initiative: .5, socialEnergy: .5, playfulness: .5, reserve: .5, conscientiousness: .5, curiosity: .5, optimism: .5 }
export const TEMPLATES: Record<string, Partial<Traits>> = {
  tsundere: { warmth: .65, reserve: .75, directness: .65, playfulness: .65, selfControl: .65, irritability: .35 },
  earnest: { conscientiousness: .9, selfControl: .8, directness: .65, playfulness: .25 },
  wilful: { directness: .8, initiative: .65, selfControl: .45, irritability: .45, reserve: .3 },
  gentle: { warmth: .85, selfControl: .85, irritability: .2, directness: .4 },
  playful: { playfulness: .9, curiosity: .7, socialEnergy: .7, warmth: .65 },
  innocent: { curiosity: .9, optimism: .8, warmth: .7, reserve: .3 },
  reserved: { reserve: .85, socialEnergy: .25, directness: .4, selfControl: .75 },
  candid: { directness: .85, reserve: .25, selfControl: .7 },
}
export interface PersonalityOptions {
  mix: Record<string, number>
  overrides: Partial<Traits>
  variation: { enabled: boolean; maxDelta: number; seed: string | null }
}
export interface PersonalityProfile {
  schemaVersion: 2
  companionId: string
  personaId: string
  revisionId: string
  parentRevisionIds: string[]
  traits: Traits
  templates: { id: string; weight: number }[]
  explicitOverrides: Partial<Traits>
  seed: string | null
  generatorVersion: string
  source: 'legacy' | 'owner' | 'mapped' | 'import'
  createdAtMs: number
}
export function validatePersonality(input: PersonalityOptions): void {
  const weights = Object.entries(input.mix)
  const sum = weights.reduce((total, [, weight]) => total + weight, 0)
  if (!Number.isFinite(sum)) throw new Error('personality.mix: total weight must be finite')
  if (weights.some(([id, weight]) => !Object.hasOwn(TEMPLATES, id) || !Number.isFinite(weight) || weight < 0) || weights.length > 0 && weights.reduce((sum, [, weight]) => sum + weight, 0) <= 0) throw new Error('personality.mix: unknown template or invalid weights')
  for (const [key, value] of Object.entries(input.overrides)) if (!TRAITS.includes(key as Trait) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`personality.overrides.${key}: expected 0..1`)
  if (!Number.isFinite(input.variation.maxDelta) || input.variation.maxDelta < 0 || input.variation.maxDelta > .05) throw new Error('personality.variation.maxDelta: expected 0...05')
  if (input.variation.seed !== null && typeof input.variation.seed !== 'string') throw new Error('personality.variation.seed: expected string or null')
}
export function composePersonality(input: { companionId: string; personaId: string; options: PersonalityOptions; nowMs: number; legacy?: Personality; parents?: string[]; source?: PersonalityProfile['source'] }): PersonalityProfile {
  validatePersonality(input.options)
  const { options } = input
  const entries = Object.entries(options.mix).sort(([a], [b]) => a.localeCompare(b))
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  const templates = entries.map(([id, weight]) => ({ id, weight: weight / total }))
  const traits = { ...NEUTRAL, ...input.legacy }
  for (const key of TRAITS) {
    if (templates.length) traits[key] = templates.reduce((sum, item) => sum + item.weight * (TEMPLATES[item.id]![key] ?? NEUTRAL[key]), 0)
    if (options.variation.enabled && options.overrides[key] === undefined) {
      if (!options.variation.seed) throw new Error('personality.variation.seed: initialization requires a persisted seed')
      const sample = createHash('sha256').update(`${options.variation.seed}:${key}:profile-v2`).digest().readUInt32BE(0) / 0xffffffff
      traits[key] = Math.max(0, Math.min(1, traits[key] + (sample * 2 - 1) * options.variation.maxDelta))
    }
  }
  Object.assign(traits, options.overrides)
  const profile = { schemaVersion: 2 as const, companionId: input.companionId, personaId: input.personaId, revisionId: '', parentRevisionIds: input.parents ?? [], traits, templates, explicitOverrides: { ...options.overrides }, seed: options.variation.enabled ? options.variation.seed : null, generatorVersion: 'profile-v2', source: input.source ?? 'owner', createdAtMs: input.nowMs }
  profile.revisionId = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
  return profile
}
