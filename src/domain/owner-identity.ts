import { randomUUID, createHash } from 'node:crypto'
import type { Config } from '../config.js'
import type { Repositories } from '../storage/repositories.js'
import type { IdentityBinding } from './types.js'
import { PRESETS } from './affect-reducer.js'

export class OwnerIdentity {
  readonly ownerId: string
  readonly deviceId: string
  readonly principalId: string

  constructor(private readonly repos: Repositories, private readonly config: Config, nowMs = Date.now()) {
    this.ownerId = repos.getSetting('owner.id') ?? randomUUID()
    this.deviceId = repos.getSetting('local.device-id') ?? randomUUID()
    repos.setSetting('owner.id', this.ownerId, nowMs)
    repos.setSetting('local.device-id', this.deviceId, nowMs)
    this.principalId = `${config.companion.id}:owner:${this.ownerId}`
    repos.ensureCompanion(config.companion.id, config.companion.name, PRESETS[config.companion.preset], nowMs)
    repos.ensurePrincipal(this.principalId, config.companion.id, 'owner', this.ownerId, nowMs)
  }

  binding(channel: string, address: string, accountId = this.deviceId, nowMs = Date.now()): IdentityBinding {
    const namespace = `${channel}:${accountId}`
    this.repos.db.run('INSERT INTO identity_links(namespace, external_key, principal_id, created_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, external_key) DO NOTHING', namespace, address, this.principalId, nowMs)
    const id = `owner-conv:${createHash('sha256').update(`${this.principalId}:${namespace}:${address}`).digest('hex').slice(0, 32)}`
    this.repos.ensureConversation(id, this.principalId, 'private', `${namespace}:${address}`, nowMs)
    this.repos.db.run('INSERT INTO owner_channels(conversation_id, channel, account_id, address) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING', id, channel, accountId, address)
    return { companionId: this.config.companion.id, botAccountId: accountId, userId: this.ownerId,
      conversationId: id, conversationKind: 'private', principalId: this.principalId, visibility: 'private' }
  }

  /** Fold only explicitly allowed private QQ identities into the same local owner. */
  adoptLegacyQq(nowMs = Date.now()): number {
    const allowed = new Set(this.config.channel.ownerChats.map(chat => chat.replace(/^private:/, '')))
    const db = this.repos.db
    const legacy = db.all<{ id: string; user_id: string; bot_account_id: string }>("SELECT * FROM principals WHERE companion_id = ? AND bot_account_id <> 'owner' AND id NOT LIKE 'review:%'", this.config.companion.id).filter(row => allowed.has(row.user_id))
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
        const baseline = this.repos.getSetting(`affect.baseline:${principal.id}`)
        if (baseline && !this.repos.getSetting(`affect.baseline:${this.principalId}`)) this.repos.setSetting(`affect.baseline:${this.principalId}`, JSON.stringify({ ...JSON.parse(baseline), principalId: this.principalId }), nowMs)
      }
    })
    return legacy.length
  }
}
