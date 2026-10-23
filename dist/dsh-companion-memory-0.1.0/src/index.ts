/**
* dsh-companion-memory 插件入口（任务书 §13.1、§15.1、§17）。 *
* 这里只做「装配 + 释放」，不放业务规则：所有行为都在 src/ 的其它模块里，
* 便于单测与离线复现。装配遵循三条硬约束： *
*   1. **每个注册都有 disposer**：提示词段、命令、HTTP 路由、定时器、后台 worker
*      全部挂在 `ctx.effect` 上，热重载后不会残留第二份（§13.1）。
*   2. **不硬编码模型名**：模型路由每轮从宿主解析，解析不到就降级（§13.1）。
*   3. **不启动第二个入站消费者**：本插件不连 OneBot WebSocket，只对外提供
*      `companionMemory` 服务，由 dsh-onebot-qq 桥把入站消息交进来（§13.2）。 */
import {
 resolveConfig }
 from './config.js'
import {
 openDatabase, type Database }
 from './storage/database.js'
import {
 migrate }
 from './storage/migrations.js'
import {
 Repositories }
 from './storage/repositories.js'
import {
 backupNow, backupDirectory, pruneBackups, listBackups }
 from './storage/backup.js'
import {
 Retriever }
 from './memory/retriever.js'
import {
 FactUpdater }
 from './memory/fact-updater.js'
import {
 Consolidator, hashKey, type ConsolidationChange, type ConsolidationPlan }
 from './memory/consolidator.js'
import {
 PromptStore, renderStateBlock }
 from './runtime/context-builder.js'
import {
 Metrics }
 from './runtime/metrics.js'
import {
 TokenLedger }
 from './runtime/context-budget.js'
import {
 ConversationQueue }
 from './runtime/conversation-queue.js'
import {
 TurnCoordinator, type InboundTurn, type TurnOutcome }
 from './runtime/turn-coordinator.js'
import {
 BackgroundQueue }
 from './runtime/background-queue.js'
import {
 ProactiveScheduler }
 from './proactive/scheduler.js'
import {
 OutboxWorker }
 from './proactive/outbox-worker.js'
import {
 handleFishCommand, looksLikeFishCommand, stripFishPrefix, type FishCommandResult }
 from './commands/handlers.js'
import {
 QqTransport, chatForSession }
 from './adapters/qq-transport.js'
import {
  HostModelCaller,  HostTurnSender,  registerPromptSection,  composePersonaText,  createTransport,  type HostContext,}
 from './adapters/dsh-adapter.js'
import {
 probeCapabilities, describeCompatibility, type CompatibilityReport }
 from './adapters/compatibility.js'
import {
 formatChatId, parseChatId, resolveBinding }
 from './domain/identity.js'
import {
 PRESETS }
 from './domain/affect-reducer.js'
import
 type {
 IdentityBinding, MemoryKind }
 from './domain/types.js'
/** Cordis 插件名。 */
export
 const name = 'dsh-companion-memory'/** * 依赖的服务。 *
* 全部声明为 optional：缺 `systemPrompt` 就退化成「把人格并进消息体」，
* 缺 `llm` 就退化成 plain 模式，缺 `commands` 只是没有斜杠命令——
* 但插件本身必须还能加载并如实报告降级（§18.3）。 */
export const inject = {
  required: [] as string[],
  optional: [
    'systemPrompt',
    'llm',
    'commands',
    'tools',
    'webServer',
    'agents',
    'sessions',
    'agentDefaultModel',
  ],
}

/** 宿主 ctx 的最小结构（其余成员一律按 unknown 处理，避免和宿主类型强绑定）。 */
interface PluginContext extends HostContext {
  systemPrompt?: {
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
  provide?(service: string, value: unknown): void
  emit?(event: string, ...args: unknown[]): void
  effect?(callback: () => (() => void) | void, label?: string): void
  on?(event: string, callback: (...args: unknown[]) => void): void
}

/** 交给 dsh-onebot-qq 桥的入站消息。 */
export interface CompanionInbound {
  /** `private:123` / `group:456`，与桥的 chatId 同构。 */
  chatId: string
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
  handleInbound(input: CompanionInbound): Promise<CompanionInboundResult>
  handleCommand(input: { text: string; chatId: string }): FishCommandResult
  isCommand(text: string): boolean
  status(): Record<string, unknown>
  compatibility(): CompatibilityReport
  /** 该 turn 的正文是否已经由本插件发出（桥据此抑制重复发送）。 */
  consumed(turnId: string): boolean
  shutdown(): Promise<void>
}
const VERSION = '0.1.0'
const SECTION_NAME = 'companion:persona'
const MEMORY_KINDS: readonly MemoryKind[] = ['episode', 'fact', 'preference', 'interaction_rule', 'hypothesis']
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
/** 从模型输出里抠出第一个 JSON 对象（巩固任务只接受结构化变更）。 */
function extractJson(text: string): unknown {
const start = text.indexOf('{')
const end = text.lastIndexOf('}')
if (start < 0 || end <= start)
return null
  try {
return JSON.parse(text.slice(start, end + 1))  }
 catch {
return null  }
}
function coerceChanges(value: unknown): ConsolidationChange[] {
if (!Array.isArray(value))
 return []
const changes: ConsolidationChange[] = []
for (const raw of value) {
const record = toRecord(raw)
const kind = pickString(record, 'kind')
const claim = pickString(record, 'claim')
const quote = pickString(record, 'quote')
const ids = record['sourceMessageIds']
if (kind === null || claim === null || quote === null) continue
if (!MEMORY_KINDS.includes(kind as MemoryKind)) continue
if (!Array.isArray(ids) || ids.length === 0) continue
const sourceMessageIds = ids.filter((id): id is string => typeof id === 'string')
if (sourceMessageIds.length === 0) continue
changes.push({
kind: kind as MemoryKind,
subject: pickString(record, 'subject'),
predicate: pickString(record, 'predicate'),
object: record['object'] ?? null,      claim,
sourceMessageIds,      quote,
confidence: typeof record['confidence'] === 'number' ? record['confidence'] : 0.6,
salience: typeof record['salience'] === 'number' ? record['salience'] : 0.5,
eventAtMs: typeof record['eventAtMs'] === 'number' ? record['eventAtMs'] : null,    })  }
return changes}
/** 装配插件。 */
export
 function apply(ctx: PluginContext, rawConfig?: unknown): void {
const config = resolveConfig(rawConfig)
const store = new PromptStore()
const metrics = new Metrics()
const ledger = new TokenLedger()
const prompts = store
  const db: Database = openDatabase(config.storage, false, config.companion.id)
migrate(db, {
 now: Date.now(), fts5: db.capabilities().fts5 })
const repos = new Repositories(db)
repos.ensureCompanion(    config.companion.id,    config.companion.name,    PRESETS[config.companion.preset],    Date.now(),  )
const retriever = new Retriever(repos, config.memory)
const updater = new FactUpdater(repos, config.memory)
const consolidator = new Consolidator(repos, config.background, updater)
const transport: QqTransport = createTransport(config)
const modelCaller = new HostModelCaller(ctx, {
 log: (message) => logger('info', message) })
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
log: logger,  })
const outbox = new OutboxWorker({
    config,    repos,
transport,    metrics,
chatForConversation: (conversationId) => chatByConversation.get(conversationId) ?? null,
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
const stateText = stored === undefined ? '' : renderStateBlock(stored.snapshot)
const systemText = composePersonaText(prompts, config)
const userText = [
'现在是你在主动开口（不是回复用户）。',
`起因：${input.candidate.kind} — ${input.candidate.topic}`,
input.candidate.reasons.length > 0 ? `依据：${input.candidate.reasons.join('；')}` : '',
stateText,
'要求：一句话到两句话，口语，不要解释你为什么说话，不要提“系统”“任务”“提醒设置”。',
'只输出正文，不要 JSON，不要引号包裹。',    ]
.filter((line) => line !== '')
.join('\n')
const parts: string[] = []
for await (const chunk of modelCaller.call({
turnId: `proactive-${hashKey(input.conversation.conversationId + input.candidate.topic)}`,
systemText,      userText,
thinking: 'disabled',    })) {
parts.push(chunk.text)    }
const text = parts.join('').trim()
return text === '' ? null : text  }
const scheduler = new ProactiveScheduler({
    config,    repos,    metrics,
listConversations: () =>      [...chatByConversation.entries()].map(([conversationId, chatId]) => {
const binding = bindingForConversation(conversationId, chatId)
const stored = binding === null ? null : repos.getSnapshot(binding.principalId)
        return {
conversationId,
principalId: binding?.principalId ?? conversationId,
grievance: stored?.snapshot.relationship.grievance ?? 0,
affection: stored?.snapshot.relationship.affection ?? 0,
unresolvedConflict: false,        }
      }),
generate: generateProactive,
mainTurnInFlight: (conversationId) => queue.isBusy(conversationId),
log: logger,  })
/** 由 chatId 还原绑定（入站、主动、命令都走这一条路径，保证口径一致）。 */
function bindingForConversation(conversationId: string, chatId: string): IdentityBinding | null {
const parsed = parseChatId(chatId)
if (!parsed)
return null
const binding = resolveBinding({
companionId: config.companion.id,
botAccountId: botAccountIdFromChat(chatId),
userId: parsed.id,
conversationId,
conversationKind: parsed.kind,    })
return binding  }
function botAccountIdFromChat(chatId: string): string {
// 桥的 chatId 只有对端 id；机器人账号取配置里的 ownerChats 反推不可靠，
// 因此统一用固定占位符，principal 的稳定性由 (companion, bot, user) 决定。
return config.companion.id === chatId ? 'self' : 'self'  }
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
const afterSeq = typeof job.payload['afterSeq'] === 'number' ? job.payload['afterSeq'] : 0
if (conversationId === null || principalId === null)
 return
const batch = consolidator.planBatch({
 conversationId, principalId, afterSeq })
if (batch.messages.length === 0)
 return
const route = await modelCaller.route()
if (!route) {
logger('warn', '巩固任务跳过：宿主没有可用的模型路由')
      return    }
const transcript = batch.messages
.map((message) => `[${message.id}] ${message.role}: ${message.content}`)
.join('\n')
const parts: string[] = []
for await (const chunk of modelCaller.call({
turnId: `bg-${job.id}`,
systemText: prompts.consolidate(),
userText: `消息如下：\n${transcript}`,
thinking: 'disabled',    })) {
parts.push(chunk.text)    }
const parsed = toRecord(extractJson(parts.join('')))
const plan: ConsolidationPlan = {
changes: coerceChanges(parsed['changes']),
cursor: typeof parsed['cursor'] === 'number' ? parsed['cursor'] : null,
summary: pickString(parsed, 'summary'),    }
const report = consolidator.applyPlan(batch, plan, Date.now())
repos.putCheckpoint({
id: hashKey(`checkpoint:${
conversationId}:${report.nextCursor}`),      conversationId,
sessionId: 'background',
summary: plan.summary ?? '',
evidenceIds: report.touchedIds,
createdAtMs: Date.now(),    })
repos.audit({
principalId,
kind: 'consolidate',
entityId: conversationId,
payload: {
 applied: report.applied, rejected: report.rejected.length }
,
createdAtMs: Date.now(),    })  })
background.register('backup', () => {
backupNow(      db,      {
directory: backupDirectory(db.file),
keepDays: config.storage.backupRetentionDays,
label: config.companion.id,      }
,      Date.now(),    )
pruneBackups(      backupDirectory(db.file),      config.storage.backupRetentionDays,      Date.now(),    )  })
// ── 服务 ────────────────────────────────────────────────────────────────────
const service: CompanionService = {
version: VERSION,
async handleInbound(input) {
const parsed = parseChatId(input.chatId)
if (!parsed) {
return {
 handled: false, replySuppressed: false, outcome: null, reason: 'invalid-chat-id' }
      }
const conversationId = `${config.companion.id}:${parsed.kind}:${parsed.id}`
const binding = resolveBinding({
companionId: config.companion.id,
botAccountId: 'self',
userId: parsed.id,
conversationId,
conversationKind: parsed.kind,      })
rememberChat(binding, input.chatId, input.sessionId)
repos.ensurePrincipal(        binding.principalId,        config.companion.id,        binding.botAccountId,        binding.userId,        Date.now(),      )
repos.ensureConversation(        binding.conversationId,        binding.principalId,        parsed.kind,        parsed.id,        Date.now(),      )
if (looksLikeFishCommand(input.text)) {
const result = service.handleCommand({
 text: input.text, chatId: input.chatId })
        return {
handled: true,
replySuppressed: false,
outcome: null,
reason: result.kind === 'success' ? 'command' : `command-error:${result.text.slice(0, 60)}`,        }
      }
const inbound: InboundTurn = {
        binding,
chatId: input.chatId,
text: input.text,
platformMessageKey: input.platformMessageKey ?? null,
occurredAtMs: input.occurredAtMs ?? Date.now(),
observedAtMs: Date.now(),
sessionId: input.sessionId ?? `chat:${input.chatId}`,
sourceKind: input.sourceKind ?? 'qq',      }
const outcome = await coordinator.handleInbound(inbound)
if (outcome.sent?.kind === 'accepted')
consumedTurns.add(outcome.turnId)
return {
 handled: true, replySuppressed: consumedTurns.has(outcome.turnId), outcome }
    }
,
handleCommand(input) {
const parsed = parseChatId(input.chatId)
if (!parsed)
return {
 kind: 'error', text: '这个会话没有可用的身份绑定。' }
const conversationId = `${config.companion.id}:${parsed.kind}:${parsed.id}`
const binding = resolveBinding({
companionId: config.companion.id,
botAccountId: 'self',
userId: parsed.id,
conversationId,
conversationKind: parsed.kind,      })
const ownerChats = config.channel.ownerChats
const isOwner = parsed.kind === 'private' && (ownerChats.length === 0 || ownerChats.includes(parsed.id))
return handleFishCommand(        {
 raw: stripFishPrefix(input.text), binding, isOwner, nowMs: Date.now() }
,        {
          config,          repos,          db,
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
scheduler.stop()
background.stop()
await background.drain(2000)
await queue.close()
db.close()    }
,  }
ctx.provide?.('companionMemory', service)
ctx.emit?.('companionMemory/available')
// ── 提示词段 ────────────────────────────────────────────────────────────────
const section = registerPromptSection(ctx, {
name: SECTION_NAME,
order: ctx.systemPrompt?.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 10,
text: () => composePersonaText(prompts, config),  })
// ── 斜杠命令 ────────────────────────────────────────────────────────────────
const commandDisposer = ctx.commands?.register({
name: 'fish',
description: '陪伴插件：status / mood / why / memory / remember / forget / correct / personality / proactive / reset / export / doctor',
input: {
 hint: 'status | mood | why | memory <关键词> | remember <内容> | forget <id> --confirm' }
,
handler: (input) => {
const rawInput = typeof input.rawInput === 'string' ? input.rawInput : ''
const chatId = chatIdForAgent(input.agent) ?? ownerChatFallback()
const result = service.handleCommand({
 text: `/fish ${rawInput}`, chatId })
return {
 kind: result.kind, text: result.text }
    }
,  })
function chatIdForAgent(agent: unknown): string | null {
const record = toRecord(agent)
const session = toRecord(record['session'])
const sessionId = pickString(session, 'id')
if (sessionId === null)
return null
const known = conversationBySession.get(sessionId)
if (known !== undefined) {
const chatId = chatByConversation.get(known)
if (chatId !== undefined)
return chatId    }
const fromFile = chatForSession(config.channel.chatSessionsFile, sessionId)
return fromFile  }
function ownerChatFallback(): string {
const owner = config.channel.ownerChats[0]
return owner !== undefined ? formatChatId('private', owner) : 'private:0'  }
// ── 诊断路由（仅回环） ──────────────────────────────────────────────────────
const webServer = ctx.webServer ?? (ctx.get?.('webServer') as PluginContext['webServer'])
if (webServer && typeof
webServer.register === 'function') {
    webServer.register({
kind: 'prefix',
path: '/companion-memory',
handler: (req, res) => {
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
background.start()
scheduler.start()
outboxTimer = setInterval(() => {
void outbox.runOnce().catch((error: unknown) => {
logger('warn', `主动消息投递失败：${error instanceof Error ? error.message : String(error)}`)    })
}
, 30_000)  ;
(
outboxTimer as {
 unref?: () => void }).unref?.()
if (config.storage.backupDaily) {
backupTimer = setInterval(() => {
backupNow(        db,        {
directory: backupDirectory(db.file),
keepDays: config.storage.backupRetentionDays,
label: config.companion.id,        }
,        Date.now(),      )
}
, 24 * 60 * 60 * 1000)    ;
(
backupTimer as {
 unref?: () => void }).unref?.()  }
const report = service.compatibility()
logger('info', describeCompatibility(report))
logger('info', `已挂载 v${VERSION}（会话 ${chatByConversation.size}，备份 ${listBackups(`${config.storage.directory}/${config.companion.id}`).length} 份）`)
// ── 释放 ────────────────────────────────────────────────────────────────────
const disposeAll = (): void => {
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
section?.dispose()
void queue.close()
void background.drain(1500)
db.close()  }
if (typeof ctx.effect === 'function') {
ctx.effect(() => disposeAll, 'companion-memory: lifecycle')  }
}
export default apply
