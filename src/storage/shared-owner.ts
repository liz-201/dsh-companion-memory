import { createHash } from 'node:crypto'
import type { Config } from '../config.js'
import type { AffectSnapshot } from '../domain/types.js'
import { initialSnapshot } from '../domain/affect-reducer.js'
import { rebuildAffect } from '../domain/affect-projector.js'
import { PersonalityProfiles } from './personality-profiles.js'
import { backupDirectory, backupNow } from './backup.js'
import type { Repositories } from './repositories.js'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const TABLES = ['conversations', 'identity_links', 'appraisals', 'relationship_episodes', 'affect_events', 'memories', 'tasks', 'background_jobs', 'deletion_tombstones', 'audit_events', 'episodic_annotations', 'expression_habits', 'proactive_feedback', 'expression_audits']

export function sharedOwnerPrincipal(config: Config, ownerId: string): string {
  return `${config.companion.id}:owner:${ownerId}`
}

/** A data migration, not a new schema: retain source IDs and evidence, with one live owner projection. */
export function unifyOwnerState(repos: Repositories, config: Config, ownerId: string, nowMs: number, options: { backup?: boolean; sourceOwnerIds?: readonly string[] } = {}): number {
  const db = repos.db, target = sharedOwnerPrincipal(config, ownerId)
  // Additional owner ids are supplied only by the explicit, previewed same-user pairing operation.
  const sources = new Set(options.sourceOwnerIds ?? [])
  sources.delete(ownerId)
  const legacy = db.all<{ id: string; user_id: string }>("SELECT id, user_id FROM principals WHERE companion_id = ? AND bot_account_id = 'owner'", config.companion.id)
    .filter(row => row.id !== target && (row.id.startsWith(target + ':persona:') || sources.has(row.user_id)))
  if (!legacy.length) return 0
  if (!db.get('SELECT id FROM principals WHERE id = ?', target)) throw Error('Shared owner identity is missing')
  const backup = options.backup !== false && db.file !== ':memory:'
    ? backupNow(db, { directory: backupDirectory(db.file), keepDays: config.storage.backupRetentionDays, label: `${config.companion.id}-before-shared-owner-${digest(legacy.map(row => row.id).sort().join(':')).slice(0, 12)}-${nowMs}` }, nowMs).file : null

  db.transaction(() => {
    const sources = [target, ...legacy.map(row => row.id)]
    const states = sources.map(id => ({ id, stored: repos.getSnapshot(id), events: repos.activeAffectEvents(id).length }))
    const profiles = new PersonalityProfiles(repos)
    const candidates = sources.map(id => ({ id, profile: profiles.get(config.companion.id, repos.getSetting(`persona.id:${id}`) ?? 'builtin'), preset: repos.getSetting(`personality.preset:${id}`) }))
      .filter((entry): entry is typeof entry & { profile: NonNullable<typeof entry.profile> } => entry.profile !== undefined)
      .sort((a, b) => Number(b.profile.source === 'owner') - Number(a.profile.source === 'owner') || b.profile.createdAtMs - a.profile.createdAtMs)
    const chosen = candidates[0]?.profile
    const archive = {
      atMs: nowMs, target, backup, states,
      settings: sources.flatMap(id => db.all<{ key: string; value: string }>('SELECT key, value FROM plugin_settings').filter(row => row.key.endsWith(':' + id) || row.key.includes(':' + id + ':'))),
    }
    const archiveId = digest(JSON.stringify(archive.states))
    repos.setSetting(`local.shared-owner.archive:${archiveId}`, JSON.stringify(archive), nowMs)

    for (const { id } of legacy) {
      // Preserve conversation IDs and all source messages even if an older import reused a platform address.
      for (const row of db.all<{ id: string; kind: string; platform_conversation_id: string }>('SELECT id, kind, platform_conversation_id FROM conversations WHERE principal_id = ?', id)) {
        if (db.get('SELECT id FROM conversations WHERE principal_id = ? AND kind = ? AND platform_conversation_id = ?', target, row.kind, row.platform_conversation_id)) {
          db.run('UPDATE conversations SET platform_conversation_id = ? WHERE id = ?', `shared-history:${row.id}:${row.platform_conversation_id}`, row.id)
        }
      }
      for (const row of db.all<{ id: string; kind: string; topic_key: string }>('SELECT id, kind, topic_key FROM proactive_opportunities WHERE principal_id = ?', id)) {
        if (db.get('SELECT id FROM proactive_opportunities WHERE principal_id = ? AND kind = ? AND topic_key = ?', target, row.kind, row.topic_key)) db.run('UPDATE proactive_opportunities SET topic_key = ? WHERE id = ?', digest(`${row.topic_key}:${row.id}`), row.id)
      }
      db.run("UPDATE outbox SET status = 'cancelled', last_error_code = 'shared-owner-migration' WHERE status = 'pending' AND opportunity_id IN (SELECT id FROM proactive_opportunities WHERE principal_id = ?)", id)
      db.run("UPDATE proactive_opportunities SET principal_id = ?, persona_id = 'builtin', status = CASE WHEN status IN ('pending','selected') THEN 'cancelled' ELSE status END WHERE principal_id = ?", target, id)
      for (const table of TABLES) if (db.all<{ name: string }>(`PRAGMA table_info(${table})`).some(column => column.name === 'principal_id')) db.run(`UPDATE ${table} SET principal_id = ? WHERE principal_id = ?`, target, id)
      db.run("UPDATE background_jobs SET payload_json = json_set(payload_json, '$.principalId', ?) WHERE json_valid(payload_json) AND json_extract(payload_json, '$.principalId') = ?", target, id)
      if (db.capabilities().fts5) db.run('UPDATE memory_fts SET principal_id = ? WHERE principal_id = ?', target, id)
      db.run('DELETE FROM affect_snapshots WHERE principal_id = ?', id)
      repos.setSetting(`identity.shared-alias:${id}`, target, nowMs)
      const snoozeKey = `proactive.snooze-until:${target}`
      const snooze = Math.max(Number(repos.getSetting(snoozeKey) ?? 0), Number(repos.getSetting(`proactive.snooze-until:${id}`) ?? 0))
      if (snooze) repos.setSetting(snoozeKey, String(snooze), nowMs)
      const interestsKey = `proactive.model-interests:${target}`
      const interests: string[] = []
      for (const principal of [target, id]) {
        try { const value = JSON.parse(repos.getSetting(`proactive.model-interests:${principal}`) ?? '[]') as unknown; if (Array.isArray(value)) interests.push(...value.filter((item): item is string => typeof item === 'string')) } catch {}
      }
      if (interests.length) repos.setSetting(interestsKey, JSON.stringify([...new Set(interests)].slice(0, 20)), nowMs)
      for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM plugin_settings')) {
        for (const prefix of ['proactive.blocked-kind:', 'proactive.blocked-source:']) {
          if (row.key.startsWith(prefix + id + ':')) repos.setSetting(prefix + target + row.key.slice((prefix + id).length), row.value, nowMs)
        }
        if (!row.key.startsWith('local.shared-owner.') && !row.key.startsWith('identity.shared-alias:') && (row.key.endsWith(':' + id) || row.key.startsWith(`proactive.blocked-kind:${id}:`) || row.key.startsWith(`proactive.blocked-source:${id}:`))) db.run('DELETE FROM plugin_settings WHERE key = ?', row.key)
      }
      db.run('DELETE FROM principals WHERE id = ?', id)
    }

    const old = repos.getSnapshot(target)
    const available = states.filter(item => item.stored !== undefined).sort((a, b) => b.stored!.snapshot.asOfMs - a.stored!.snapshot.asOfMs)
    const nonDefault = (state: AffectSnapshot): boolean => {
      const initial = initialSnapshot(target, config.companion.preset, config.affect.ruleVersion, nowMs)
      return Object.keys(initial.relationship).some(key => Math.abs(state.relationship[key as keyof typeof state.relationship] - initial.relationship[key as keyof typeof initial.relationship]) > .001)
    }
    const unsupported = available.filter(item => item.events === 0 && nonDefault(item.stored!.snapshot))
    const hasEvents = repos.activeAffectEvents(target).length > 0
    const seed = unsupported[0]?.stored?.snapshot ?? available[0]?.stored?.snapshot ?? initialSnapshot(target, config.companion.preset, config.affect.ruleVersion, nowMs)
    const firstEvent = db.get<{ at: number }>("SELECT MIN(event_time_ms) AS at FROM affect_events WHERE principal_id = ? AND status = 'active'", target)?.at ?? nowMs
    let rebased = false
    if (hasEvents) {
      const saved = repos.getSetting(`affect.baseline:${target}`)
      const previous = saved ? JSON.parse(saved) as AffectSnapshot : undefined
      // A reset/old snapshot dated after newly joined history cannot be used as that history's starting point.
      rebased = previous !== undefined && previous.asOfMs > firstEvent
      const baseline = previous && !rebased ? previous : initialSnapshot(target, config.companion.preset, config.affect.ruleVersion, firstEvent)
      repos.setSetting(`affect.baseline:${target}`, JSON.stringify({ ...baseline, principalId: target, asOfMs: firstEvent, openEpisodeIds: [], projectedThroughSeq: 0 }), nowMs)
    }
    const personality = chosen?.traits ?? seed.personality
    if (chosen && chosen.personaId !== 'builtin') profiles.configure(config.companion.id, 'builtin', seed.personality, { mix: {}, overrides: chosen.traits, variation: { enabled: false, maxDelta: .05, seed: null } }, nowMs, chosen.source)
    repos.setSetting(`persona.id:${target}`, 'builtin', nowMs)
    const selectedPreset = candidates[0]?.preset ?? repos.getSetting(`personality.preset:${target}`)
    const preset = selectedPreset === 'balanced' || selectedPreset === 'gentle' || selectedPreset === 'irritable' ? selectedPreset : config.companion.preset
    repos.setSetting(`personality.default:${target}`, preset, nowMs)
    repos.setSetting(`personality.profile-preset:${target}`, preset, nowMs)
    repos.setSetting(`personality.preset:${target}`, preset, nowMs)
    const legacyPersonality = Object.fromEntries(Object.keys(seed.personality).map(key => [key, personality[key as keyof typeof personality]])) as unknown as AffectSnapshot['personality']
    repos.putSnapshot({ ...seed, principalId: target, personality: legacyPersonality, revision: (old?.revision ?? 0) + 1 }, old?.revision ?? 0)
    if (hasEvents) {
      const before = repos.getSnapshot(target)!
      repos.putSnapshot(rebuildAffect(repos, config, target, nowMs), before.revision)
    }
    repos.setSetting('memory.identity-mode', 'shared-owner-v1', nowMs)
    repos.setSetting('local.shared-owner.report', JSON.stringify({ merged: legacy.length, backup, archiveId, atMs: nowMs, unsupportedSnapshots: unsupported.length, rebased, target }), nowMs)
    repos.audit({ principalId: target, kind: 'memory.shared-owner-migration', entityId: archiveId, payload: { sources, backup, replayedEvents: repos.activeAffectEvents(target).length, unsupportedSnapshots: unsupported.length, rebased }, createdAtMs: nowMs })
    if (db.all('PRAGMA foreign_key_check').length) throw Error('Shared memory migration would break references')
  })
  return legacy.length
}
