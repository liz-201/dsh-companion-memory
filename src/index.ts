import { ReviewSandbox } from './runtime/review-sandbox.js'
import { OwnerIdentity } from './domain/owner-identity.js'
import { registerDevice } from './runtime/device-context.js'
import { StartupSync } from './storage/startup-sync.js'
import { MemoryTransfer } from './cloud/memory-transfer.js'
import { createTransferHandler } from './cloud/transfer-ui.js'
import { installLocalIntegration } from './adapters/local-integration.js'
import { hostService } from './adapters/host-service.js'
import { PersonaContexts } from './runtime/persona-context.js'
import { personalityPreset } from './domain/personality.js'
import { scheduleConsolidation, recoverConsolidationJobs } from './runtime/consolidation-scheduler.js'
import { requestConsolidationPlan } from './memory/consolidation-output.js'
import { scheduleDailyBackup } from './runtime/backup-scheduler.js'
import { renderInteractionHabits } from './memory/interaction-habits.js'
import { DesktopDelivery } from './adapters/desktop-delivery.js'
import { ExpressionRuntime } from './expression/runtime.js'
import { CORE_POLICY, renderPlan } from './expression/policy.js'
import { randomUUID } from 'node:crypto'
import { ShareSources } from './proactive/share-sources.js'
import { archiveMemories } from './memory/episodic.js'
import { StreamParser } from './runtime/stream-parser.js'
import { estimateTokens } from './runtime/context-budget.js'
import { rebuildAffect } from './domain/affect-projector.js'
﻿/** Compose request-scoped companion services; no global persona or second QQ connection. */
import { resolveConfig } from './config.js'
import { openDatabase, type Database } from './storage/database.js'
import { migrate, migrationStatus } from './storage/migrations.js'
import { Repositories } from './storage/repositories.js'
import { backupNow, backupDirectory, pruneBackups, listBackups } from './storage/backup.js'
import { Retriever } from './memory/retriever.js'
import { FactUpdater } from './memory/fact-updater.js'
import { Consolidator, hashKey } from './memory/consolidator.js'
import { PromptStore, renderStateBlock } from './runtime/context-builder.js'
import { Metrics } from './runtime/metrics.js'
import { TokenLedger } from './runtime/context-budget.js'
import { ConversationQueue } from './runtime/conversation-queue.js'
import { TurnCoordinator, type InboundTurn, type TurnOutcome } from './runtime/turn-coordinator.js'
import { BackgroundQueue } from './runtime/background-queue.js'
import { ProactiveScheduler } from './proactive/scheduler.js'
import { OutboxWorker } from './proactive/outbox-worker.js'
import { handleFishCommand, looksLikeFishCommand, stripFishPrefix, type FishCommandResult } from './commands/handlers.js'
import { QqTransport, chatForSession } from './adapters/qq-transport.js'
import { HostModelCaller, HostTurnSender, composePersonaText, createTransport, type HostContext } from './adapters/dsh-adapter.js'
import { probeCapabilities, describeCompatibility, type CompatibilityReport } from './adapters/compatibility.js'
import { formatChatId, parseChatId, resolveBinding, decideActivation } from './domain/identity.js'
import { PRESETS, projectSnapshot } from './domain/affect-reducer.js'
import type { IdentityBinding, DeliveryReceipt } from './domain/types.js'
/** Cordis 插件名。 */
export
 const name = 'dsh-companion-memory'
/** Optional services use ctx.get / child injection; Cordis treats object keys as service names. */
export const inject: string[] = []

/** 宿主 ctx 的最小结构（其余成员一律按 unknown 处理，避免和宿主类型强绑定）。 */
interface PluginContext extends HostContext {
  systemPrompt?: {
    context?(options: { name: string; order: number; required: boolean; interpolate: boolean; text: (context: unknown) => string }): () => void
    section(options: {
      name: string
      order: number
      interpolate?: boolean
      text: () => string
    }): () => void
    getSectionOrder?(name: string): number
  }
  commands?: {
    register(definition: {
      name: string
      description: string
      input?: { hint?: string }
      handler: (input: {
        agent?: unknown
        rawInput?: unknown
      }) => { kind: 'success' | 'error'; text: string }
    }): unknown
  }
  webServer?: {
    register(route: {
      kind: string
      path: string
      handler: (req: unknown, res: unknown) => void
    }): () => void
  }
  get?(service: string): unknown
  inject?(services: string[], callback: (context: PluginContext) => void): { dispose(): unknown }
  provide?(service: string, value: unknown): void
  emit?(event: string, ...args: unknown[]): void
  effect?(callback: () => (() => void) | void, label?: string): void
  on?(event: string, callback: (...args: unknown[]) => unknown): unknown
}

/** 交给 dsh-onebot-qq 桥的入站消息。 */
export interface CompanionInbound {
  /** `private:123` / `group:456`，与桥的 chatId 同构。 */
  chatId: string
  botAccountId?: string
  userId?: string
  send?: (text: string, turnId: string) => Promise<DeliveryReceipt>
  text: string
  platformMessageKey?: string | null
  occurredAtMs?: number
  /** 宿主会话 id；有就记下来，便于 `/fish` 反查。 */
  sessionId?: string | null
  sourceKind?: string | null
}

export interface CompanionInboundResult {
  /** 是否被本插件接手；false 时桥应该走它自己的默认路径。 */
  handled: boolean
  /** 本次已经替桥发过正文（桥不应再发一遍，§13.2 默认抑制）。 */
  replySuppressed: boolean
  outcome: TurnOutcome | null
  reason?: string
}

/** 插件对外暴露的服务；桥、CLI、诊断页都通过它取状态。 */
export interface CompanionService {
  readonly version: string
  accepts(chatId: string): boolean
  handleInbound(input: CompanionInbound): Promise<CompanionInboundResult>
  handleCommand(input: { text: string; chatId: string; botAccountId?: string }): FishCommandResult
  isCommand(text: string): boolean
  status(): Record<string, unknown>
  compatibility(): CompatibilityReport
  /** 该 turn 的正文是否已经由本插件发出（桥据此抑制重复发送）。 */
  consumed(turnId: string): boolean
  shutdown(): Promise<void>
}
const VERSION = '0.3.0-dev.4'
function logger(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
const prefix = '[companion]'
if (level === 'error')
console.error(prefix, message)
else
 if (level === 'warn')
console.warn(prefix, message)
  else
console.log(prefix, message)}
function toRecord(value: unknown): Record<string, unknown> {
return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {
}
}
function pickString(record: Record<string, unknown>, key: string): string | null {
const value = record[key]
return typeof value === 'string' && value !== '' ? value : null}
/** 装配插件。 */
export
 function apply(ctx: PluginContext, rawConfig?: unknown): void {
const config = structuredClone(resolveConfig(rawConfig))
const store = new PromptStore()
const metrics = new Metrics()
const ledger = new TokenLedger()
const prompts = store
  const db: Database = openDatabase(config.storage, false, config.companion.id)
if (config.memory.migrationMode === 'backup_then_migrate' && db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companions'") && migrationStatus(db).pending.length) backupNow(db, { directory: backupDirectory(db.file), keepDays: config.storage.backupRetentionDays, label: `${config.companion.id}-pre-v03-${Date.now()}` }, Date.now())
migrate(db, {
 now: Date.now(), fts5: db.capabilities().fts5 })
const repos = new Repositories(db)
metrics.attachStorage(repos)
const sync = new StartupSync(db, config)
sync.importAtStartup()
for (const row of db.all<{ key: string }>("SELECT key FROM plugin_settings WHERE key LIKE 'local.affect-rebuild:%' AND value = '1'")) {
  const principalId = row.key.slice('local.affect-rebuild:'.length), stored = repos.getSnapshot(principalId)
  repos.putSnapshot(rebuildAffect(repos, config, principalId, Date.now()), stored?.revision ?? 0)
  repos.setSetting(row.key, '0', Date.now())
}
const device = registerDevice(repos)
const owner = new OwnerIdentity(repos, config, Date.now(), device.id)
const transfer = new MemoryTransfer(db, config, device.id)
const transferHandler = createTransferHandler(transfer)
const manageUrl = (): string => {
  const web = hostService(ctx, 'webServer') as { getOrigin?: () => string } | undefined
  try { return new URL('/companion-memory/manage', web?.getOrigin?.()).href } catch { return '/companion-memory/manage' }
}
const firstKnownDevice = repos.db.all<{ key: string; value: string }>("SELECT key, value FROM plugin_settings WHERE key LIKE 'device.known:%'").sort((a, b) => Number(toRecord(JSON.parse(a.value))['firstSeenAtMs']) - Number(toRecord(JSON.parse(b.value))['firstSeenAtMs']) || a.key.localeCompare(b.key))[0]?.key.slice('device.known:'.length) ?? device.id
const bootstrapOwnership = randomUUID()
if (repos.db.run('INSERT OR IGNORE INTO proactive_ownership VALUES (?, ?, ?, ?, NULL)', config.companion.id, firstKnownDevice, bootstrapOwnership, '[]').changes) repos.setSetting('local.proactive.bootstrap-ownership', bootstrapOwnership, Date.now())
const desktop = new DesktopDelivery(repos)
const personas = new PersonaContexts(repos, config)
owner.adoptLegacyQq()
repos.recoverOutbox()
const savedProactive = repos.getSetting('proactive.enabled')
if (savedProactive !== undefined) config.proactive.enabled = savedProactive === '1'
const review = new ReviewSandbox(repos, config)
repos.ensureCompanion(    config.companion.id,    config.companion.name,    PRESETS[config.companion.preset],    Date.now(),  )
const retriever = new Retriever(repos, config.memory)
const updater = new FactUpdater(repos, config.memory)
const consolidator = new Consolidator(repos, config.background, updater)
const transport: QqTransport = createTransport(config)
const modelCaller = new HostModelCaller(ctx, {
 log: (message) => logger('info', message) })
const expression = new ExpressionRuntime(repos, config, modelCaller.call)
const shareSources = new ShareSources(repos, config)
const queue = new ConversationQueue({
})
const background = new BackgroundQueue(repos, metrics, {
enabled: true,
maxRetries: config.background.retryLimit,  })
/** 已知会话：chatId ↔ conversationId，供发送与主动消息反查。 */
const chatByConversation = new Map<string, string>()
const conversationBySession = new Map<string, string>()
/** 已由本插件发过正文的 turnId（§13.2 默认抑制桥的最终发送）。 */
const consumedTurns = new Set<string>()
const sender = new HostTurnSender({
transport,
resolveChatId: (conversationId) => chatByConversation.get(conversationId) ?? null,
log: (message) => logger('warn', message),  })
const coordinator = new TurnCoordinator({
    config,    repos,
retriever,    updater,    queue,    metrics,    ledger,    prompts,
background,
send: sender.send,
callModel: modelCaller.call,
deviceText: device.text,
log: logger,  })
const outbox = new OutboxWorker({
    config,    repos,
transport,    metrics,
chatForConversation: (conversationId) => desktop.has(conversationId) ? `desktop:${conversationId}` : chatByConversation.get(conversationId)?.startsWith('desktop:') ? null : chatByConversation.get(conversationId) ?? null,
send: async (conversationId, content, key, expectedSeq) => desktop.has(conversationId) ? desktop.send(conversationId, content, key, expectedSeq) : transport.sendText(chatByConversation.get(conversationId) ?? '', content),
targetBusy: conversationId => desktop.isBusy(conversationId) || queue.isBusy(conversationId),
now: () => Date.now(),  })
/** 主动消息正文生成；解析不到路由就放弃这次（不臆造模型名）。 */
const generateProactive = async (input: {
    candidate: {
 kind: string;
 topic: string;
 reasons: string[] }
    conversation: {
 conversationId: string;
 principalId: string }
  }): Promise<string | null> => {
const route = await modelCaller.route()
if (!route)
return null
const stored = repos.getSnapshot(input.conversation.principalId)
const projected = stored ? projectSnapshot(stored.snapshot, Date.now(), config.affect) : undefined
const stateText = projected ? (config.integration.naturalExpression ? renderPlan(expression.plan(projected, input.candidate.topic, Date.now())) : renderStateBlock(projected)) : ''
const proactiveBinding = bindingForConversation(input.conversation.conversationId, chatByConversation.get(input.conversation.conversationId) ?? '')
const habitText = config.integration.naturalExpression && proactiveBinding ? renderInteractionHabits(repos, proactiveBinding, Date.now()) : ''
const localPersona = desktop.has(input.conversation.conversationId) ? desktop.personaText(input.conversation.conversationId) : null
if (desktop.has(input.conversation.conversationId) && !localPersona) return null
const systemText = (localPersona ?? composePersonaText(prompts, { ...config, companion: { ...config.companion, preset: personalityPreset(repos, config, input.conversation.principalId) } })) + '\n' + CORE_POLICY
const userText = [
'现在是你在主动开口（不是回复用户）。',
`起因：${input.candidate.kind} — ${input.candidate.topic}`,
input.candidate.reasons.length > 0 ? `依据：${input.candidate.reasons.join('；')}` : '',
stateText,
habitText,
'要求：一句话到两句话，口语，不要解释你为什么说话，不要提“系统”“任务”“提醒设置”。',
'只输出正文，不要 JSON，不要引号包裹。',    ]
.filter((line) => line !== '')
.join('\n')
const parts: string[] = []
if (estimateTokens(systemText) + estimateTokens(userText) + 16 > config.memory.inputHardLimitTokens) { metrics.count('proactive.input-budget-exceeded', 1); return null }
for await (const chunk of modelCaller.call({
turnId: `proactive-${hashKey(input.conversation.conversationId + input.candidate.topic)}`,
systemText,      userText,
thinking: 'disabled',    })) {
parts.push(chunk.text)    }
const text = parts.join('').trim()
if (/<\/?(?:say|evt)\b/.test(text)) {
  const parser = new StreamParser()
  parser.feed(text)
  const parsed = parser.finish().result
  return parsed.problems.includes('say-unclosed') ? null : parsed.say
}
return text === '' ? null : text  }
const scheduler = new ProactiveScheduler({
    config,    repos,    metrics,
beforeScan: nowMs => shareSources.scan(desktop.list().map(item => desktop.binding(item.conversationId)!).filter(Boolean), nowMs),
listConversations: () =>      [...chatByConversation.entries()].filter(([id, chatId]) => !id.startsWith('review:') && (!chatId.startsWith('desktop:') || desktop.has(id))).map(([conversationId, chatId]) => {
const binding = bindingForConversation(conversationId, chatId)
const stored = binding === null ? null : repos.getSnapshot(binding.principalId)
        return {
conversationId,
principalId: binding?.principalId ?? conversationId,
grievance: stored?.snapshot.relationship.grievance ?? 0,
affection: stored?.snapshot.relationship.affection ?? 0,
unresolvedConflict: binding !== null && repos.listEpisodes(binding.principalId, ['open', 'repairing'], 1).length > 0,        }
      }),
generate: generateProactive,
mainTurnInFlight: (conversationId) => queue.isBusy(conversationId) || desktop.isBusy(conversationId),
prepare: async (conversationId, content, _expectedSeq, candidateKey) => {
  const principal = repos.db.get<{ principal_id: string }>('SELECT principal_id FROM conversations WHERE id = ?', conversationId)
  const state = principal ? repos.getSnapshot(principal.principal_id)?.snapshot : undefined
  if (!state) return null
  const candidate = repos.db.get<{ source_ids_json: string }>('SELECT source_ids_json FROM proactive_opportunities WHERE id = ?', candidateKey)
  return (await expression.guard(content, state, candidateKey.startsWith('reminder:') ? '逐字保留提醒原文' : '闲聊主动接续真实共同话题', Date.now(), undefined, candidate ? JSON.parse(candidate.source_ids_json) as string[] : [])).text
},
log: logger,  })
/** 由 chatId 还原绑定（入站、主动、命令都走这一条路径，保证口径一致）。 */
function bindingForConversation(conversationId: string, chatId: string): IdentityBinding | null {
  if (chatId.startsWith('desktop:')) return desktop.binding(conversationId)
  const ownerChannel = db.get<{ account_id: string; address: string }>('SELECT account_id, address FROM owner_channels WHERE conversation_id = ? AND channel = ?', conversationId, 'qq')
  if (ownerChannel) return { ...owner.binding('qq', ownerChannel.address, ownerChannel.account_id), conversationId }
  const parsed = parseChatId(chatId)
  if (!parsed) return null
  const row = db.get<{ bot_account_id: string; user_id: string }>('SELECT p.bot_account_id, p.user_id FROM conversations c JOIN principals p ON p.id = c.principal_id WHERE c.id = ?', conversationId)
  return resolveBinding({ companionId: config.companion.id, botAccountId: row?.bot_account_id ?? 'self', userId: row?.user_id ?? parsed.id, conversationId, conversationKind: parsed.kind })
}
function realBinding(chatId: string, botAccountId = 'self', userId?: string): IdentityBinding {
  const parsed = parseChatId(chatId)!
  if (parsed.kind === 'private' && config.channel.ownerChats.includes(chatId)) return owner.binding('qq', chatId, botAccountId)
  const conversationId = botAccountId === 'self'
    ? `${config.companion.id}:${parsed.kind}:${parsed.id}`
    : `${config.companion.id}:${botAccountId}:${parsed.kind}:${parsed.id}`
  const binding = resolveBinding({ companionId: config.companion.id, botAccountId, userId: parsed.kind === 'private' ? parsed.id : userId ?? parsed.id, conversationId, conversationKind: parsed.kind })
  repos.ensurePrincipal(binding.principalId, config.companion.id, binding.botAccountId, binding.userId, Date.now())
  repos.ensureConversation(conversationId, binding.principalId, parsed.kind, chatId, Date.now())
  return binding
}
// Restore known targets so confirmed reminders survive a process restart before the next inbound.
for (const row of db.all<{ id: string; kind: 'private' | 'group'; platform_conversation_id: string; address: string | null }>("SELECT c.id, c.kind, c.platform_conversation_id, o.address FROM conversations c LEFT JOIN owner_channels o ON o.conversation_id = c.id WHERE c.enabled = 1 AND c.id NOT LIKE 'review:%' AND (o.channel IS NULL OR o.channel = 'qq')")) {
  const chatId = row.address ?? (row.platform_conversation_id.includes(':') ? row.platform_conversation_id : formatChatId(row.kind, row.platform_conversation_id))
  if (decideActivation(config.companion, config.channel, chatId).active) chatByConversation.set(row.id, chatId)
}
/** 记住 chatId ↔ conversationId 的关系，供主动消息与命令反查。 */
function rememberChat(binding: IdentityBinding, chatId: string, sessionId?: string | null): void {
chatByConversation.set(binding.conversationId, chatId)
if (typeof sessionId === 'string' && sessionId !== '') {
conversationBySession.set(sessionId, binding.conversationId)    }
  }
// ── 后台任务 ────────────────────────────────────────────────────────────────
background.register('consolidate', async (job) => {
const conversationId = pickString(job.payload, 'conversationId')
const principalId = pickString(job.payload, 'principalId')
const afterSeq = Number(repos.getSetting(`consolidation.cursor:${conversationId}`) ?? job.payload['afterSeq'] ?? 0)
if (conversationId === null || principalId === null)
 return
const batch = consolidator.planBatch({
 conversationId, principalId, afterSeq })
const continueBatch = () => scheduleConsolidation(repos, config, background, conversationId, principalId, Date.now(), {
  throughSeq: Number(job.payload['throughSeq'] ?? batch.cursor), excludeJobId: job.id,
})
if (batch.messages.length === 0) {
  if (batch.cursor <= afterSeq && Number(job.payload['throughSeq'] ?? 0) > afterSeq) throw new Error('整理批次未推进：首条消息可能超出输入预算，原文保留，请检查 background.inputLimitTokens')
  repos.setSetting(`consolidation.cursor:${conversationId}`, String(batch.cursor), Date.now())
  continueBatch()
  return
}
const route = await modelCaller.route()
if (!route) {
throw new Error('巩固任务等待可用的模型路由')    }
const transcript = batch.messages
.map((message) => `[${message.id}] seq=${message.seq} ${message.role}: ${message.content}`)
.join('\n')
const result = await requestConsolidationPlan(batch, afterSeq, async correction => {
const parts: string[] = []
for await (const chunk of modelCaller.call({
turnId: `bg-${job.id}`,
systemText: prompts.consolidate(),
userText: `消息如下：\n${transcript}${correction ? `\n\n${correction}` : ''}`,
thinking: 'disabled',    })) {
parts.push(chunk.text)    }
return parts.join('')
})
const plan = result.plan
if (result.degraded) repos.audit({ principalId, kind: 'consolidate-degraded', entityId: conversationId, payload: { jobId: job.id, attempts: result.attempts, problems: result.problems, fromSeq: afterSeq, throughSeq: batch.cursor, originalMessageIds: batch.messages.map(message => message.id), originalsRetained: true }, createdAtMs: Date.now() })
const report = consolidator.applyPlan(batch, plan, Date.now())
archiveMemories(repos, principalId, Date.now() - 180 * 86400000)
repos.setSetting(`consolidation.cursor:${conversationId}`, String(report.nextCursor), Date.now())
repos.putCheckpoint({
id: hashKey(`checkpoint:${
conversationId}:${report.nextCursor}`),      conversationId,
sessionId: 'background',
summary: { topic: plan.summary ?? '' },
evidenceIds: report.touchedIds,
createdAtMs: Date.now(),    })
repos.audit({
principalId,
kind: 'consolidate',
entityId: conversationId,
payload: {
 applied: report.applied, rejected: report.rejected.length }
,
createdAtMs: Date.now(),    })
continueBatch()
  })
recoverConsolidationJobs(repos, Date.now())
background.register('backup', () => {
backupNow(      db,      {
directory: backupDirectory(db.file),
keepDays: config.storage.backupRetentionDays,
label: config.companion.id,      }
,      Date.now(),    )
pruneBackups(      backupDirectory(db.file),      config.storage.backupRetentionDays,      Date.now(),    )  })
// ── 服务 ────────────────────────────────────────────────────────────────────
let active = true
const service: CompanionService = {
version: VERSION,
accepts(chatId) { return active && decideActivation(config.companion, config.channel, chatId).active },
async handleInbound(input) {
  await transfer.ready
  if (!service.accepts(input.chatId) || config.generation.mode === 'plain') return { handled: false, replySuppressed: false, outcome: null, reason: 'scope-disabled' }
  const parsed = parseChatId(input.chatId)!
  if (parsed.kind === 'group' && !input.userId) return { handled: false, replySuppressed: false, outcome: null, reason: 'missing-group-user' }
  const real = realBinding(input.chatId, input.botAccountId, input.userId)
  rememberChat(real, input.chatId, input.sessionId)
  const sandbox = review.binding(real)
  const binding = sandbox ?? real
  rememberChat(binding, input.chatId, input.sessionId)
  if (looksLikeFishCommand(input.text)) {
    const result = service.handleCommand({ text: input.text, chatId: input.chatId, botAccountId: input.botAccountId })
    if (input.send) await input.send(result.text, `command-${Date.now()}`)
    return { handled: true, replySuppressed: true, outcome: null, reason: 'command' }
  }
  const inbound: InboundTurn = { binding, chatId: input.chatId, text: input.text,
    platformMessageKey: input.platformMessageKey ?? null, occurredAtMs: input.occurredAtMs ?? Date.now(), observedAtMs: Date.now(),
    sessionId: input.sessionId ?? `chat:${input.chatId}`, sourceKind: input.sourceKind ?? 'qq', review: sandbox !== null,
    ...(input.send ? { send: request => input.send!(request.text, request.turnId) } : {}) }
  const outcome = await coordinator.handleInbound(inbound)
  // Once handled, even an unknown receipt must suppress the original bridge's fallback send.
  consumedTurns.add(outcome.turnId)
  if (consumedTurns.size > 2000) consumedTurns.delete(consumedTurns.values().next().value!)
  return { handled: true, replySuppressed: true, outcome }
},
handleCommand(input) {
const parsed = parseChatId(input.chatId)
if (!parsed)
return {
 kind: 'error', text: '这个会话没有可用的身份绑定。' }
if (!service.accepts(input.chatId)) return { kind: 'error', text: '此会话没有启用陪伴功能。' }
const existingConversation = [...chatByConversation.entries()].find(([id, chat]) => chat === input.chatId && !id.startsWith('review:'))
const real = input.botAccountId ? realBinding(input.chatId, input.botAccountId) : existingConversation ? bindingForConversation(existingConversation[0], input.chatId)! : realBinding(input.chatId)
const raw = stripFishPrefix(input.text)
const binding = /^review(?:\s|$)/.test(raw) ? real : review.binding(real) ?? real
const isOwner = parsed.kind === 'private' && config.channel.ownerChats.includes(input.chatId)
return handleFishCommand(        {
 raw: stripFishPrefix(input.text), binding, isOwner, nowMs: Date.now() }
,        {
          review: {
            begin: (fixture) => { if (queue.isBusy(real.conversationId)) throw new Error('当前回合尚未结束，请稍后进入 review。'); return review.begin(real, fixture, Date.now()) },
            end: () => { const active = review.binding(real); if (active && queue.isBusy(active.conversationId)) throw new Error('测试回合尚未结束，请稍后退出。'); return review.end(real) },
          },
          config,          repos,          db, transfer, manageUrl, publishLocal: () => publish() ? sync.lastExport : null,
retriever,          updater,          metrics,
compatibility: () => service.compatibility(),
scheduler: {
status: () => ({
enabled: config.proactive.enabled,
pending: repos.counts().outbox ?? 0,
lastScanAtMs: null,
nextCheckAtMs: null,            }),
setEnabled: (enabled: boolean) => {
config.proactive.enabled = enabled            }
,          }
,
outboxStats: () => repos.counts(),
backgroundStats: () => background.backlog(),
log: (message) => logger('info', message),        }
,      )    }
,
isCommand: looksLikeFishCommand,
status() {
      return {
version: VERSION,
companion: config.companion,
device,
sync: { directory: sync.directory, imports: sync.reports, lastExport: sync.lastExport, cloud: transfer.status(), manageUrl: manageUrl() },
expression: { mode: config.expression.mode, supportedProtocol: 'desktop-0.2.1-rc.2', qualityVerified: false },
integration: { ...config.integration, hooksAvailable: typeof ctx.on === 'function', ownerId: owner.ownerId },
delivery: transport.configured ? 'bridge' : 'plain-body-only',
chats: chatByConversation.size,
counts: repos.counts(),
metrics: metrics.summary(),
background: background.stats(),
scheduler: scheduler.running,
database: db.file,
capabilities: service.compatibility().capabilities,      }
    }
,
compatibility() {
return probeCapabilities(ctx, {
onebotHttpBase: config.channel.onebotHttpBase,
chatSessionsFile: config.channel.chatSessionsFile,      })    }
,
consumed(turnId) {
return consumedTurns.has(turnId)    }
,
async shutdown() {
  disposeAll()
  await transfer.stop()
  await background.drain(1500)
  db.close()
}
,  }
ctx.provide?.('companionMemory', service)
ctx.emit?.('companionMemory/available')
const localDisposer = installLocalIntegration({
  ...(ctx.on ? { on: ctx.on.bind(ctx) } : {}), config, owner, repos, retriever, background, coordinator,
  ready: () => transfer.isReady, whenReady: () => transfer.ready,
  callModel: modelCaller.call, prompts, deviceText: device.text, active: () => active, personas,
  expression,
  busy: (id, value) => desktop.setBusy(id, value),
  disposed: id => desktop.remove(id),
  localTarget: (session, binding, personaId) => { desktop.register(session, binding, personaId); if (desktop.has(binding.conversationId)) chatByConversation.set(binding.conversationId, `desktop:${String(toRecord(session)['id'])}`) },
  ...(ctx.inject ? { runtimeContext: (text: (context: unknown) => string) => {
    const fiber = ctx.inject!(['systemPrompt'], child => {
      const prompt = hostService(child, 'systemPrompt') as PluginContext['systemPrompt']
      prompt?.context?.({ name: 'companion-memory:local', order: 500, required: true, interpolate: false, text })
    })
    return () => { void fiber.dispose() }
  } } : {}),
})
const publish = (): boolean => {
  try { sync.publish(device.id); return true } catch (error) { logger('warn', `记忆同步文件写入失败：${String(error)}`); return false }
}
publish()
for (const report of sync.reports) if (report.error || report.conflicts) logger('warn', `记忆同步需检查：${JSON.stringify(report)}`)
const syncTimer = setInterval(publish, config.storage.syncIntervalSeconds * 1000)
syncTimer.unref()
// ── 提示词段 ────────────────────────────────────────────────────────────────
const registerCommands = (context: PluginContext) => (hostService(context, 'commands') as PluginContext['commands'])?.register({
name: 'fish',
description: '陪伴插件：status / mood / why / memory / remember / forget / correct / personality / proactive / reset / export / doctor',
input: {
 hint: 'status | mood | why | memory <关键词> | remember <内容> | forget <id> --confirm' }
,
handler: (input) => {
const rawInput = typeof input.rawInput === 'string' ? input.rawInput : ''
const chatId = chatIdForAgent(input.agent)
if (!chatId) {
  const agent = toRecord(input.agent)
  const sessionId = pickString(toRecord(agent['session']), 'id')
  if (!config.integration.enabled || !config.integration.localOwner || !sessionId || config.integration.excludedAgentIds.includes(String(agent['id']))) return { kind: 'error', text: '当前会话没有启用本地主人记忆。' }
  const persona = personas.resolve(agent)
  const result = handleFishCommand({ raw: rawInput, binding: owner.binding('dsh', sessionId, owner.deviceId, Date.now(), persona), isOwner: true, nowMs: Date.now() }, { config, repos, db, retriever, updater, metrics, transfer, manageUrl, publishLocal: () => publish() ? sync.lastExport : null })
  if (rawInput.trim() === 'status') result.text += `\n当前角色：${persona.id}`
  if (rawInput.trim() === 'status') result.text += `\n${device.text}\n同步目录：${sync.directory}\n启动同步：${sync.reports.filter(report => !report.error).length} 份；失败 ${sync.reports.filter(report => report.error).length} 份；冲突 ${sync.reports.reduce((sum, report) => sum + (report.conflicts ?? 0), 0)} 条`
  return result
}
const result = service.handleCommand({
 text: `/fish ${rawInput}`, chatId })
return {
 kind: result.kind, text: result.text }
    }
,  })
let commandDisposer: unknown
if (ctx.inject) {
  const fiber = ctx.inject(['commands'], child => {
    const dispose = registerCommands(child)
    if (typeof dispose === 'function') child.effect?.(() => dispose as () => void)
  })
  commandDisposer = () => { void fiber.dispose() }
} else commandDisposer = registerCommands(ctx)
function chatIdForAgent(agent: unknown): string | null {
const record = toRecord(agent)
const session = toRecord(record['session'])
const sessionId = pickString(session, 'id')
if (sessionId === null)
return null
const known = conversationBySession.get(sessionId)
if (known !== undefined) {
const chatId = chatByConversation.get(known)
if (chatId?.startsWith('desktop:')) return null
if (chatId !== undefined)
return chatId    }
const fromFile = chatForSession(config.channel.chatSessionsFile, sessionId)
return fromFile  }
// ── 诊断路由（仅回环） ──────────────────────────────────────────────────────
let webDisposer: (() => void) | undefined
const webServer = hostService(ctx, 'webServer') as PluginContext['webServer']
if (webServer && typeof
webServer.register === 'function') {
    webDisposer = webServer.register({
kind: 'prefix',
path: '/companion-memory',
handler: (req, res) => {
const path = (req as { url?: string }).url ?? ''
if (path.startsWith('/companion-memory/manage') || path.startsWith('/companion-memory/api/')) {
  void transferHandler(req as import('node:http').IncomingMessage, res as import('node:http').ServerResponse)
  return
}
const response = res as {
          writeHead?(code: number, headers: Record<string, string>): void
          end?(body: string): void        }
const request = req as {
 socket?: {
 remoteAddress?: string }
 }
const remote = String(request.socket?.remoteAddress ?? '')
const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
const body = loopback
? JSON.stringify({
 ok: true, status: service.status(), compatibility: describeCompatibility(service.compatibility()) })
: JSON.stringify({
 ok: false, error: 'loopback only' })
response.writeHead?.(loopback ? 200 : 403, {
 'content-type': 'application/json; charset=utf-8' })
response.end?.(body)      }
,    })  }
// ── 定时器 ──────────────────────────────────────────────────────────────────
let outboxTimer: ReturnType<typeof setInterval> | null = null
let backupTimer: ReturnType<typeof setInterval> | null = null
transfer.start()
if (transfer.isReady) { background.start(); scheduler.start() }
else void transfer.ready.then(() => { if (active) { background.start(); scheduler.start() } })
outboxTimer = setInterval(() => {
if (!transfer.isReady) return
void outbox.runOnce().catch((error: unknown) => {
logger('warn', `主动消息投递失败：${error instanceof Error ? error.message : String(error)}`)    })
}
, 30_000)  ;
(
outboxTimer as {
 unref?: () => void }).unref?.()
if (config.storage.backupDaily) {
scheduleDailyBackup(config, background, Date.now())
backupTimer = setInterval(() => { scheduleDailyBackup(config, background, Date.now()) }, 60 * 60 * 1000)    ;
(
backupTimer as {
 unref?: () => void }).unref?.()  }
const report = service.compatibility()
logger('info', describeCompatibility(report))
logger('info', `已挂载 v${VERSION}（会话 ${chatByConversation.size}，备份 ${listBackups(backupDirectory(db.file)).length} 份）`)
// ── 释放 ────────────────────────────────────────────────────────────────────
const disposeAll = (): void => {
if (!active) return
active = false
localDisposer()
clearInterval(syncTimer)
publish()
webDisposer?.()
if (outboxTimer !== null) {
clearInterval(outboxTimer)
outboxTimer = null    }
if (backupTimer !== null) {
clearInterval(backupTimer)
backupTimer = null    }
scheduler.stop()
background.stop()
if (typeof
commandDisposer === 'function') (commandDisposer as () => void)()

void queue.close()
void Promise.all([background.drain(1500), transfer.stop()]).then(() => db.close())  }
if (typeof ctx.effect === 'function') {
ctx.effect(() => disposeAll, 'companion-memory: lifecycle')  }
}
export default apply
