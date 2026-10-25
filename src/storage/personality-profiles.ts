import { randomUUID } from 'node:crypto'
import type { Repositories } from './repositories.js'
import type { Personality } from '../domain/types.js'
import { composePersonality, type PersonalityOptions, type PersonalityProfile } from '../domain/personality-profile.js'

export class PersonalityProfiles {
  constructor(private readonly repos: Repositories) {}

  get(companionId: string, personaId: string): PersonalityProfile | undefined {
    const row = this.repos.db.get<Record<string, unknown>>('SELECT p.* FROM personality_profiles p JOIN personality_heads h ON h.revision_id = p.revision_id WHERE h.companion_id = ? AND h.persona_id = ?', companionId, personaId)
    if (!row) return undefined
    return { schemaVersion: 2, companionId, personaId, revisionId: String(row['revision_id']), parentRevisionIds: JSON.parse(String(row['parent_revision_ids_json'])), traits: JSON.parse(String(row['traits_json'])), templates: JSON.parse(String(row['templates_json'])), explicitOverrides: JSON.parse(String(row['overrides_json'])), seed: row['seed'] as string | null, generatorVersion: String(row['generator_version']), source: row['source'] as PersonalityProfile['source'], createdAtMs: Number(row['created_at_ms']) }
  }

  ensure(companionId: string, personaId: string, legacy: Personality, options: PersonalityOptions, nowMs: number): PersonalityProfile {
    return this.get(companionId, personaId) ?? this.configure(companionId, personaId, legacy, options, nowMs, 'legacy')
  }

  configure(companionId: string, personaId: string, legacy: Personality, options: PersonalityOptions, nowMs: number, source: PersonalityProfile['source'] = 'owner'): PersonalityProfile {
    const previous = this.get(companionId, personaId)
    const conflict = this.repos.db.get<{ conflict_json: string | null }>('SELECT conflict_json FROM personality_heads WHERE companion_id = ? AND persona_id = ?', companionId, personaId)?.conflict_json
    const parents = [...new Set([...(previous ? [previous.revisionId] : []), ...(conflict ? JSON.parse(conflict) as string[] : [])])]
    const effective = { ...options, variation: { ...options.variation, seed: options.variation.seed ?? (options.variation.enabled ? randomUUID() : null) } }
    const profile = composePersonality({ companionId, personaId, legacy, options: effective, nowMs, source, parents })
    this.repos.db.transaction(() => {
      this.repos.db.run('INSERT OR IGNORE INTO personality_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', profile.revisionId, companionId, personaId, JSON.stringify(profile.parentRevisionIds), JSON.stringify(profile.traits), JSON.stringify(profile.templates), JSON.stringify(profile.explicitOverrides), profile.seed, profile.generatorVersion, source, nowMs)
      this.repos.db.run('INSERT INTO personality_heads VALUES (?, ?, ?, NULL) ON CONFLICT(companion_id, persona_id) DO UPDATE SET revision_id = excluded.revision_id, conflict_json = NULL', companionId, personaId, profile.revisionId)
    })
    return profile
  }
}
