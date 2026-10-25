import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type { Database } from '../storage/database.js'
import type { Repositories } from '../storage/repositories.js'
import type { OwnerIdentity } from '../domain/owner-identity.js'
import type { IdentityBinding } from '../domain/types.js'
import { initialSnapshot, projectSnapshot } from '../domain/affect-reducer.js'
import { handleFishCommand, type FishCommandDeps } from '../commands/handlers.js'
import { PersonalityProfiles } from '../storage/personality-profiles.js'
import { proactiveFrequency } from '../proactive/frequency.js'
import { companionInterests } from '../proactive/interests.js'
import { checkGates } from '../proactive/candidate-builder.js'
import { clearComputerEvidence } from '../proactive/computer-opportunities.js'
import { backupNow, backupDirectory, backupSummary } from '../storage/backup.js'
import type { ComputerEvents } from '../runtime/computer-events.js'
import { updatePanelSettings } from './settings.js'
import { PanelInputError } from './errors.js'

export interface PanelControls { snapshot(input: { conversationId?: string; query?: string }): unknown; action(input: unknown): unknown | Promise<unknown> }
interface PanelOptions {
  config: Config; db: Database; repos: Repositories; owner: OwnerIdentity
  commands: FishCommandDeps; computer: ComputerEvents
  activeTargets: () => IdentityBinding[]; status: () => unknown
  settingsChanged: () => void; scan: () => Promise<unknown>; preview: (binding: IdentityBinding) => Promise<unknown>
  background: { start(): void; stop(): void; stats(): unknown }
  review: { begin(binding: IdentityBinding, fixture: string, nowMs: number): string; end(binding: IdentityBinding): string }
}
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('请求格式无效。'); return value as Record<string, unknown> }
const text = (value: unknown, max = 2000): string => { if (typeof value !== 'string' || value.length > max) throw Error('文字为空或过长。'); return value.trim() }

export class PluginPanel implements PanelControls {
  constructor(private readonly options: PanelOptions) {}
  private conversations() {
    const { repos, config, owner } = this.options
    const prefix = `${config.companion.id}:owner:${owner.ownerId}`
    const targets = new Set(this.options.activeTargets().map(binding => binding.conversationId))
    return repos.db.all<{ id: string; principal_id: string; platform_conversation_id: string }>("SELECT c.* FROM conversations c JOIN principals p ON p.id = c.principal_id WHERE p.companion_id = ? AND c.kind = 'private' ORDER BY (SELECT MAX(observed_at_ms) FROM raw_messages WHERE conversation_id = c.id) DESC", config.companion.id)
      .filter(row => row.principal_id === prefix || row.principal_id.startsWith(prefix + ':persona:')).slice(0, 100)
      .map(row => ({ ...row, personaId: repos.getSetting(`persona.id:${row.principal_id}`) ?? 'builtin', available: targets.has(row.id) }))
  }
  private binding(conversationId?: string): IdentityBinding {
    const rows = this.conversations(), row = conversationId ? rows.find(row => row.id === conversationId) : rows.find(row => row.available) ?? rows[0]
    if (conversationId && !row) throw Error('请选择当前主人的会话。')
    if (!row) return this.options.owner.binding('panel', 'control-center')
    const target = this.options.activeTargets().find(binding => binding.conversationId === row.id)
    return target ?? { companionId: this.options.config.companion.id, botAccountId: this.options.owner.deviceId, userId: this.options.owner.ownerId, conversationId: row.id, conversationKind: 'private', principalId: row.principal_id, visibility: 'private' }
  }
  snapshot(input: { conversationId?: string; query?: string } = {}) {
    const { config, repos, db, owner, computer } = this.options
    const conversations = this.conversations(), selected = input.conversationId ? conversations.find(row => row.id === input.conversationId) : conversations.find(row => row.available) ?? conversations[0]
    if (input.conversationId && !selected) throw Error('请选择当前主人的会话。')
    const principalId = selected?.principal_id ?? owner.principalId, conversationId = selected?.id ?? ''
    const now = Date.now(), stored = repos.getSnapshot(principalId)
    const state = projectSnapshot(stored?.snapshot ?? initialSnapshot(principalId, config.companion.preset, config.affect.ruleVersion, now), now, config.affect)
    const profile = new PersonalityProfiles(repos).get(config.companion.id, selected?.personaId ?? 'builtin')
    const query = (input.query ?? '').slice(0, 200).toLowerCase()
    return { runtime: this.options.status(), conversations: conversations.map(row => ({ id: row.id, personaId: row.personaId, label: `${row.personaId} · ${row.platform_conversation_id.slice(-60)}`, available: row.available })), selected: conversationId, state, profile, frequency: proactiveFrequency(config, repos, principalId), gates: checkGates({ config, repos, principalId, conversationId, nowMs: now }), proactive: { ...config.proactive, modelInterests: companionInterests(repos, config, principalId), enabled: (repos.getSetting('proactive.enabled') ?? (config.proactive.enabled ? '1' : '0')) === '1' }, computer: { settings: config.computerEvents, status: computer.status(), recent: computer.recent() },
      memories: repos.activeMemories(principalId, ['episode', 'fact', 'preference', 'interaction_rule', 'hypothesis'], 200).filter(row => row.visibility === 'private' && (!query || row.claim.toLowerCase().includes(query))).slice(0, 100),
      habits: db.all('SELECT id, kind, value_json, status FROM expression_habits WHERE principal_id = ? ORDER BY valid_from_ms DESC LIMIT 30', principalId),
      tasks: db.all('SELECT id, kind, content, status, due_at_ms FROM tasks WHERE principal_id = ? ORDER BY created_at_ms DESC LIMIT 40', principalId),
      opportunities: db.all('SELECT kind, summary, status, not_before_ms FROM proactive_opportunities WHERE principal_id = ? ORDER BY created_at_ms DESC LIMIT 20', principalId),
      events: db.all('SELECT seq, payload_json, event_time_ms, status FROM affect_events WHERE principal_id = ? ORDER BY seq DESC LIMIT 30', principalId),
      feedback: db.all('SELECT f.id, f.kind, f.evidence_quote, f.created_at_ms FROM proactive_feedback f WHERE f.principal_id = ? AND NOT EXISTS (SELECT 1 FROM proactive_feedback next WHERE next.supersedes_id = f.id) ORDER BY f.created_at_ms DESC LIMIT 20', principalId),
      expression: db.all('SELECT mode, issues_json, status, repair_calls, created_at_ms FROM expression_audits WHERE principal_id = ? ORDER BY created_at_ms DESC LIMIT 20', principalId),
      backups: backupSummary(backupDirectory(db.file)), background: this.options.background.stats() }
  }
  async action(input: unknown): Promise<unknown> {
    const body = object(input), action = text(body['action'], 80)
    const { config, db, repos } = this.options
    if (action === 'settings') {
      if (!this.conversations().length) throw new PanelInputError('请先在 DSH 中与需要设置的角色聊一句，再选择该会话保存设置。')
      const binding = this.binding(typeof body['conversationId'] === 'string' ? body['conversationId'] : undefined)
      updatePanelSettings(repos, config, body['settings'], true, binding.principalId)
      if (!config.computerEvents.enabled) clearComputerEvidence(repos)
      this.options.settingsChanged()
      return { text: '设置已保存并生效。角色兴趣仅应用于所选角色，联系频率与电脑感知设置应用于本机。' }
    }
    if (action === 'computer-clear') { clearComputerEvidence(repos); return { text: '已清除本机事件线索和相关待发消息。' } }
    const binding = this.binding(typeof body['conversationId'] === 'string' ? body['conversationId'] : undefined)
    if (action === 'preview') return this.options.preview(binding)
    if (action === 'scan') return this.options.scan()
    if (action === 'background-pause') { this.options.background.stop(); return { text: '后台整理已暂停，正在进行的任务会正常收尾。' } }
    if (action === 'background-resume') { this.options.background.start(); return { text: '后台整理已恢复。' } }
    if (action === 'backup') return { text: '一致性备份已创建。', backup: backupNow(db, { directory: backupDirectory(db.file), label: `${config.companion.id}-manual-${randomUUID().slice(0, 8)}`, keepDays: config.storage.backupRetentionDays }, Date.now()) }
    if (action === 'task-add') {
      const content = text(body['text']), due = Number(body['dueAtMs'])
      if (!content || !Number.isFinite(due) || due <= Date.now()) throw Error('请填写提醒内容与未来的提醒时间。')
      repos.insertTask({ id: randomUUID(), principalId: binding.principalId, conversationId: binding.conversationId, sourceMessageId: null, kind: 'reminder', content, status: 'confirmed', dueAtMs: due, timezone: config.proactive.timezone, expiresAtMs: due + 86400000, createdAtMs: Date.now() })
      return { text: '提醒已保存。' }
    }
    if (action === 'task-cancel') {
      const id = text(body['id'], 200)
      db.transaction(() => { db.run("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND principal_id = ?", id, binding.principalId); db.run("UPDATE outbox SET status = 'cancelled' WHERE task_id = ? AND status = 'pending' AND conversation_id IN (SELECT id FROM conversations WHERE principal_id = ?)", id, binding.principalId) })
      return { text: '已取消提醒或待续任务。' }
    }
    const commands: Record<string, () => string> = {
      status: () => 'status', mood: () => 'mood 1', why: () => 'why', doctor: () => 'doctor',
      'proactive-why': () => 'proactive why', 'expression-why': () => 'expression why',
      'feedback-correct': () => `proactive feedback ${text(body['id'], 200)} ${text(body['kind'], 30)}`,
      remember: () => `remember ${text(body['text'])}`, forget: () => `forget ${text(body['id'], 200)} --confirm`,
      correct: () => `correct ${Number(body['sequence'])} ${text(body['text'])}`,
      'proactive-on': () => 'proactive resume', 'proactive-off': () => 'proactive pause', 'device-take': () => 'proactive device take',
      'personality-preset': () => `personality ${text(body['preset'], 30)}`,
      'personality-set': () => `personality set ${Object.entries(object(body['traits'])).map(([key, value]) => `${key}=${Number(value)}`).join(' ')}`,
      'personality-mix': () => `personality mix ${Object.entries(object(body['mix'])).map(([key, value]) => `${key}=${Number(value)}`).join(' ')}`,
      'habit-forget': () => `habits forget ${text(body['id'], 200)}`, 'reset-relationship': () => 'reset relationship --confirm',
      'review-begin': () => `review begin ${text(body['fixture'], 30)}`, 'review-end': () => 'review end',
    }
    if (!commands[action]) throw Error('未知操作。')
    if (['forget', 'reset-relationship', 'device-take'].includes(action) && body['confirmed'] !== true) throw Error('请先确认这项操作。')
    return handleFishCommand({ raw: commands[action]!(), binding, isOwner: true, nowMs: Date.now() }, { ...this.options.commands, review: { begin: fixture => this.options.review.begin(binding, fixture, Date.now()), end: () => this.options.review.end(binding) } })
  }
}
