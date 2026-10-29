#!/usr/bin/env node
/**
 * 回放（任务书 §19 / §23）：用确定性脚本模型驱动整条链路，验证协议、
 * 预算、情感 reducer、记忆写入与 outbox 在长序列下不跑偏。
 *
 *   node scripts/replay.mjs --turns 10000
 *   node scripts/replay.mjs --turns 200 --json
 *
 * 全程不联网、不读真实数据目录：临时 SQLite + 脚本化模型输出。
 * 任何一条断言失败都会以非零退出码结束，并打印失败轮次与原因。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const turns = Math.max(1, Math.min(20000, argValue('--turns', 200)))

const { resolveConfig } = await import('../lib/config.js')
const { PRESETS } = await import('../lib/domain/affect-reducer.js')
const { openDatabase } = await import('../lib/storage/database.js')
const { migrate } = await import('../lib/storage/migrations.js')
const { Repositories } = await import('../lib/storage/repositories.js')
const { FactUpdater } = await import('../lib/memory/fact-updater.js')
const { Retriever } = await import('../lib/memory/retriever.js')
const { ConversationQueue } = await import('../lib/runtime/conversation-queue.js')
const { Metrics } = await import('../lib/runtime/metrics.js')
const { TokenLedger } = await import('../lib/runtime/context-budget.js')
const { PromptStore } = await import('../lib/runtime/context-builder.js')
const { TurnCoordinator } = await import('../lib/runtime/turn-coordinator.js')

const config = resolveConfig({})
const T0 = 1_760_000_000_000
const dir = mkdtempSync(join(tmpdir(), 'companion-replay-'))
const db = openDatabase({ ...config.storage, directory: dir }, true)
migrate(db, { now: T0 })
const repos = new Repositories(db)
repos.ensureCompanion('dafeiyu', '大肥鱼', PRESETS.balanced, T0)
const principal = repos.ensurePrincipal('p-replay', 'dafeiyu', 'bot-replay', 'user-replay', T0)
repos.ensureConversation('c-replay', principal.id, 'private', 'private:replay', T0)

const binding = {
  companionId: 'dafeiyu',
  botAccountId: 'bot-replay',
  userId: 'user-replay',
  conversationId: 'c-replay',
  conversationKind: 'private',
  principalId: principal.id,
  visibility: 'private',
}

// 脚本化模型：覆盖正常、无 evt、畸形 evt、越权字段、超长正文、缺闭合。
const script = [
  { say: '又加班？你们那个项目还没完？', evt: { v: 1, e: [{ k: 'neutral', to: 'unknown', i: 'neutral', s: 0, c: 0.4 }] } },
  { say: '行吧，先吃点东西。', evt: null },
  { say: '别拿报错来骂我。', evt: { v: 1, e: [{ k: 'insult', to: 'self', i: 'hostile', s: 2, c: 0.92 }], a: 'retort' } },
  { say: '……我在。', evt: { v: 1, e: [{ k: 'appreciation', to: 'self', i: 'playful', s: 1, c: 0.8 }] } },
  { say: '你上次说的那个 bug 修好了？', evt: { v: 1, e: [{ k: 'neutral', to: 'problem', i: 'neutral', s: 0, c: 0.5 }], m: [{ k: 'fact', t: '用户今天加班到很晚', q: '今天加班到很晚' }] } },
]
const malformed = [
  '<say>这段没有 evt</say>',
  '<say>evt 畸形</say><evt>{"v":1,"e":[</evt>',
  '<say>越权字段</say><evt>{"v":1,"e":[{"k":"teasing","to":"self","i":"playful","s":1,"c":0.7,"srcMessageId":"fake"}]}</evt>',
  `<say>${'很长的正文'.repeat(600)}</say>`,
  '完全没有协议包装的一段话',
]

function renderModelOutput(index) {
  if (index % 7 === 6) return malformed[Math.floor(index / 7) % malformed.length]
  const step = script[index % script.length]
  const parts = [`<say>${step.say}</say>`]
  if (step.evt) parts.push(`<evt>${JSON.stringify(step.evt)}</evt>`)
  return parts.join('')
}

const sent = []
const metrics = new Metrics()
const ledger = new TokenLedger()
const prompts = new PromptStore()
const queue = new ConversationQueue()
const retriever = new Retriever(repos, config.memory)
const updater = new FactUpdater(repos, config.memory)

let modelCalls = 0
let foregroundCalls = 0, repairCalls = 0
let replayNow = T0
const requestMeasurements = []
const coordinator = new TurnCoordinator({
  config,
  repos,
  retriever,
  updater,
  queue,
  metrics,
  ledger,
  prompts,
  send: async (request) => {
    sent.push(request.text)
    return { kind: 'accepted', platformMessageId: `replay-${sent.length}`, atMs: replayNow }
  },
  callModel: async function* (request) {
    if (request.turnId.startsWith('repair:')) {
      modelCalls++; repairCalls++
      yield { text: JSON.parse(request.userText).draft }
      return
    }
    const { estimateTokens } = await import('../lib/runtime/context-budget.js')
    const total = estimateTokens(request.systemText) + estimateTokens(request.userText) + 12
    requestMeasurements.push(total)
    if (total > config.memory.inputHardLimitTokens) throw new Error(`完整请求超预算：${total}`)
    modelCalls++
    const text = renderModelOutput(foregroundCalls++)
    const step = Math.max(1, Math.floor(text.length / 4))
    for (let offset = 0; offset < text.length; offset += step) {
      yield { text: text.slice(offset, offset + step) }
    }
    yield { text: '', usage: { inputTokens: 1200, outputTokens: 180, provider: 'replay', model: 'scripted' } }
  },
  clock: { now: () => replayNow },
})

const statuses = {}
const problems = {}
const failures = []

for (let index = 0; index < turns; index += 1) {
  replayNow = T0 + index * 1000
  const text = `第 ${index} 轮：今天加班到很晚`
  let outcome
  try {
    outcome = await coordinator.handleInbound({
      binding,
      chatId: 'private:user-replay',
      text,
      platformMessageKey: `replay-${index}`,
      occurredAtMs: T0 + index * 1000,
      observedAtMs: T0 + index * 1000,
      // Exercise the real human QQ ingress; model usage remains labelled replay.
      sourceKind: 'qq',
      sessionId: 'session-replay',
    })
  } catch (error) {
    failures.push({ turn: index, reason: `异常：${error.message}` })
    continue
  }
  statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1
  for (const problem of outcome.problems ?? []) problems[problem] = (problems[problem] ?? 0) + 1

  // 不变量
  if (outcome.say && /<\/?(say|evt)>/.test(outcome.say)) {
    failures.push({ turn: index, reason: '正文泄漏了协议标记' })
  }
  if (outcome.status === 'completed' && !outcome.say) {
    failures.push({ turn: index, reason: '完成态却没有正文' })
  }
  if (!outcome.budget) failures.push({ turn: index, reason: '缺少预算记录' })
  if (outcome.status === 'failed') failures.push({ turn: index, reason: outcome.error ?? '回合失败' })
  if (outcome.problems?.some(item => item.startsWith('evt-apply-failed'))) failures.push({ turn: index, reason: outcome.problems.join(',') })
}

const counts = repos.counts()
// 记忆写入必须真的发生过：全部 hint 被拒说明写入链路没通（§24：不能只看文件存在）。
if (counts.memories === 0) failures.push({ turn: -1, reason: '记忆从未写入：memory hint 全部被拒' })
if (sent.length !== turns) failures.push({ turn: -1, reason: `发送条数 ${sent.length} 与轮数 ${turns} 不一致` })
if (foregroundCalls !== turns) failures.push({ turn: -1, reason: `前台模型调用 ${foregroundCalls} 与轮数 ${turns} 不一致` })
const auditedRepairs = Number(db.get('SELECT COALESCE(SUM(repair_calls),0) AS n FROM expression_audits')?.n ?? 0)
if (repairCalls !== auditedRepairs) failures.push({ turn: -1, reason: '修复调用与审计不一致' })
const result = {
  generatedAt: new Date().toISOString(),
  turns,
  statuses,
  problems,
  failures: failures.slice(0, 20),
  failureCount: failures.length,
  counts,
  metrics: metrics.snapshot(),
  ledger: ledger.summary(),
  sentMessages: sent.length,
  modelCalls,
  foregroundCalls,
  repairCalls,
  maxEstimatedRequestTokens: Math.max(0, ...requestMeasurements),
}

mkdirSync(join(root, 'artifacts'), { recursive: true })
const outFile = join(root, 'artifacts', `replay-${result.generatedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

if (asJson) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`replay · ${turns} 轮 · 发送 ${sent.length} 条`)
  console.log('─'.repeat(62))
  console.log('状态分布', JSON.stringify(statuses))
  console.log('解析问题', JSON.stringify(problems))
  console.log(`记忆 ${counts.memories} · 原文 ${counts.raw_messages} · 轮次 ${counts.turns} · outbox ${counts.outbox}`)
  console.log(`报告 ${outFile}`)
}

db.close()
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
} catch {
  /* 临时目录留给系统清理 */
}

if (failures.length > 0) {
  console.error(`回放失败 ${failures.length} 处，首例：第 ${failures[0].turn} 轮 ${failures[0].reason}`)
  process.exit(1)
}
