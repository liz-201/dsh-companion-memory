import { randomUUID, createHash } from 'node:crypto'
import type { Config } from '../config.js'
import type { Repositories } from '../storage/repositories.js'
import type { IdentityBinding } from './types.js'
import { PRESETS, initialSnapshot } from './affect-reducer.js'
import type { PersonaContext } from '../runtime/persona-context.js'
import { inspectDevice } from '../runtime/device-context.js'
import { PersonalityProfiles } from '../storage/personality-profiles.js'
import { unifyOwnerState } from '../storage/shared-owner.js'

export class OwnerIdentity {
  get ownerId(): string { return this.repos.getSetting('owner.id') ?? this.initialOwnerId }
  readonly deviceId: string
  get principalId(): string { return `${this.config.companion.id}:owner:${this.ownerId}` }
  private readonly initialOwnerId: string

  constructor(private readonly repos: Repositories, private readonly config: Config, nowMs = Date.now(), deviceId = inspectDevice().id) {
    this.initialOwnerId = repos.getSetting('owner.id') ?? randomUUID()
    this.deviceId = deviceId
    repos.setSetting('owner.id', this.ownerId, nowMs)
    repos.setSetting('local.device-id', this.deviceId, nowMs)
    repos.ensureCompanion(config.companion.id, config.companion.name, PRESETS[config.companion.preset], nowMs)
    repos.ensurePrincipal(this.principalId, config.companion.id, 'owner', this.ownerId, nowMs)
    unifyOwnerState(repos, config, this.ownerId, nowMs)
  }

  binding(channel: string, address: string, accountId = this.deviceId, nowMs = Date.now(), persona: PersonaContext = { id: 'builtin', preset: this.config.companion.preset }): IdentityBinding {
    const principalId = this.principalId
    this.repos.ensurePrincipal(principalId, this.config.companion.id, 'owner', this.ownerId, nowMs)
    // Host personas shape the current reply, but never create another memory or relationship identity.
    if (this.repos.getSetting(`persona.id:${principalId}`) !== 'builtin') this.repos.setSetting(`persona.id:${principalId}`, 'builtin', nowMs)
    const selected = this.repos.getSetting(`personality.preset:${principalId}`) ?? this.repos.getSetting('companion.preset')
    const preset = selected === 'irritable' || selected === 'gentle' || selected === 'balanced' ? selected : this.config.companion.preset
    const stored = this.repos.getSnapshot(principalId)
    const marker = `personality.default:${principalId}`
    // Keep the relationship and mood intact when changing the temperament default.
    // Explicit /fish selections (including old builtin selections) always win.
    if (!stored || this.repos.getSetting(marker) !== preset) {
      const snapshot = stored?.snapshot ?? initialSnapshot(principalId, preset, this.config.affect.ruleVersion, nowMs)
      this.repos.putSnapshot({ ...snapshot, personality: { ...PRESETS[preset] }, revision: (stored?.revision ?? 0) + 1 }, stored?.revision ?? 0)
      this.repos.setSetting(marker, preset, nowMs)
    }
    const profiles = new PersonalityProfiles(this.repos)
    let profile = profiles.ensure(this.config.companion.id, 'builtin', this.repos.getSnapshot(principalId)!.snapshot.personality, stored ? { mix: {}, overrides: {}, variation: { enabled: false, maxDelta: .05, seed: null } } : this.config.personality, nowMs)
    const profileMarker = `personality.profile-preset:${principalId}`
    if (selected && this.repos.getSetting(profileMarker) !== preset) profile = profiles.configure(this.config.companion.id, 'builtin', PRESETS[preset], { mix: {}, overrides: { ...profile.traits, ...PRESETS[preset] }, variation: { enabled: false, maxDelta: .05, seed: null } }, nowMs)
    this.repos.setSetting(profileMarker, preset, nowMs)
    const current = this.repos.getSnapshot(principalId)!
    const legacy = Object.fromEntries(Object.keys(PRESETS[preset]).map(key => [key, profile.traits[key as keyof typeof profile.traits]])) as unknown as typeof current.snapshot.personality
    if (JSON.stringify(current.snapshot.personality) !== JSON.stringify(legacy)) this.repos.putSnapshot({ ...current.snapshot, personality: legacy, revision: current.revision + 1 }, current.revision)
    const namespace = `${channel}:${accountId}`
    this.repos.db.run('INSERT INTO identity_links(namespace, external_key, principal_id, created_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, external_key) DO NOTHING', namespace, address, principalId, nowMs)
    const canonicalId = `owner-conv:${createHash('sha256').update(`${principalId}:${namespace}:${address}`).digest('hex').slice(0, 32)}`
    // Reuse an existing channel conversation after migration so reminders and sequence guards retain their destination.
    const existing = this.repos.db.get<{ id: string }>('SELECT c.id FROM conversations c JOIN owner_channels o ON o.conversation_id = c.id WHERE c.principal_id = ? AND o.channel = ? AND o.account_id = ? AND o.address = ? ORDER BY CASE WHEN c.id = ? THEN 0 ELSE 1 END, c.id LIMIT 1', principalId, channel, accountId, address, canonicalId)
    const id = existing?.id ?? canonicalId
    this.repos.ensureConversation(id, principalId, 'private', `${namespace}:${address}`, nowMs)
    this.repos.setSetting(`local.session-persona:${id}`, persona.id, nowMs)
    this.repos.db.run('INSERT INTO owner_channels(conversation_id, channel, account_id, address) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING', id, channel, accountId, address)
    return { companionId: this.config.companion.id, botAccountId: accountId, userId: this.ownerId,
      conversationId: id, conversationKind: 'private', principalId, visibility: 'private' }
  }

  /** Fold only explicitly allowed private QQ identities into the same local owner. */
  adoptLegacyQq(nowMs = Date.now()): number {
    const allowed = new Set(this.config.channel.ownerChats.map(chat => chat.replace(/^private:/, '')))
    const db = this.repos.db
    const legacy = db.all<{ id: string; user_id: string; bot_account_id: string }>("SELECT p.* FROM principals p WHERE companion_id = ? AND bot_account_id <> 'owner' AND p.id NOT LIKE 'review:%' AND EXISTS (SELECT 1 FROM conversations c WHERE c.principal_id = p.id AND c.kind = 'private') AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.principal_id = p.id AND c.kind = 'group')", this.config.companion.id).filter(row => allowed.has(row.user_id))
    if (!legacy.length) return 0
    db.transaction(() => {
      const tables = ['conversations', 'appraisals', 'relationship_episodes', 'affect_events', 'memories', 'tasks', 'background_jobs', 'deletion_tombstones', 'audit_events', 'identity_links']
      for (const principal of legacy) {
        const oldSnapshot = this.repos.getSnapshot(principal.id)
        const existing = this.repos.getSnapshot(this.principalId)
        db.run('DELETE FROM affect_snapshots WHERE principal_id = ?', principal.id)
        if (oldSnapshot && (!existing || oldSnapshot.snapshot.asOfMs > existing.snapshot.asOfMs)) {
          this.repos.putSnapshot({ ...oldSnapshot.snapshot, principalId: this.principalId }, existing?.revision ?? 0)
        }
        for (const row of db.all<{ id: string }>('SELECT id FROM conversations WHERE principal_id = ?', principal.id)) {
          db.run('UPDATE conversations SET platform_conversation_id = ? WHERE id = ?', `legacy:${principal.bot_account_id}:${row.id}`, row.id)
          db.run('INSERT OR IGNORE INTO owner_channels VALUES (?, ?, ?, ?)', row.id, 'qq', principal.bot_account_id, `private:${principal.user_id}`)
        }
        for (const table of tables) {
          if (db.all<{ name: string }>(`PRAGMA table_info(${table})`).some(column => column.name === 'principal_id')) db.run(`UPDATE ${table} SET principal_id = ? WHERE principal_id = ?`, this.principalId, principal.id)
        }
        if (db.capabilities().fts5) db.run('UPDATE memory_fts SET principal_id = ? WHERE principal_id = ?', this.principalId, principal.id)
        const baseline = this.repos.getSetting(`affect.baseline:${principal.id}`)
        if (baseline && !this.repos.getSetting(`affect.baseline:${this.principalId}`)) this.repos.setSetting(`affect.baseline:${this.principalId}`, JSON.stringify({ ...JSON.parse(baseline), principalId: this.principalId }), nowMs)
      }
    })
    return legacy.length
  }
}
