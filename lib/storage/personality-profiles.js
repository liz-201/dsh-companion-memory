import { randomUUID } from 'node:crypto';
import { composePersonality } from '../domain/personality-profile.js';
export class PersonalityProfiles {
    repos;
    constructor(repos) {
        this.repos = repos;
    }
    get(companionId, personaId) {
        const row = this.repos.db.get('SELECT p.* FROM personality_profiles p JOIN personality_heads h ON h.revision_id = p.revision_id WHERE h.companion_id = ? AND h.persona_id = ?', companionId, personaId);
        if (!row)
            return undefined;
        return { schemaVersion: 2, companionId, personaId, revisionId: String(row['revision_id']), parentRevisionIds: JSON.parse(String(row['parent_revision_ids_json'])), traits: JSON.parse(String(row['traits_json'])), templates: JSON.parse(String(row['templates_json'])), explicitOverrides: JSON.parse(String(row['overrides_json'])), seed: row['seed'], generatorVersion: String(row['generator_version']), source: row['source'], createdAtMs: Number(row['created_at_ms']) };
    }
    ensure(companionId, personaId, legacy, options, nowMs) {
        return this.get(companionId, personaId) ?? this.configure(companionId, personaId, legacy, options, nowMs, 'legacy');
    }
    configure(companionId, personaId, legacy, options, nowMs, source = 'owner') {
        const previous = this.get(companionId, personaId);
        const conflict = this.repos.db.get('SELECT conflict_json FROM personality_heads WHERE companion_id = ? AND persona_id = ?', companionId, personaId)?.conflict_json;
        const parents = [...new Set([...(previous ? [previous.revisionId] : []), ...(conflict ? JSON.parse(conflict) : [])])];
        const effective = { ...options, variation: { ...options.variation, seed: options.variation.seed ?? (options.variation.enabled ? randomUUID() : null) } };
        const profile = composePersonality({ companionId, personaId, legacy, options: effective, nowMs, source, parents });
        this.repos.db.transaction(() => {
            this.repos.db.run('INSERT OR IGNORE INTO personality_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', profile.revisionId, companionId, personaId, JSON.stringify(profile.parentRevisionIds), JSON.stringify(profile.traits), JSON.stringify(profile.templates), JSON.stringify(profile.explicitOverrides), profile.seed, profile.generatorVersion, source, nowMs);
            this.repos.db.run('INSERT INTO personality_heads VALUES (?, ?, ?, NULL) ON CONFLICT(companion_id, persona_id) DO UPDATE SET revision_id = excluded.revision_id, conflict_json = NULL', companionId, personaId, profile.revisionId);
        });
        return profile;
    }
}
//# sourceMappingURL=personality-profiles.js.map