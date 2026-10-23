#!/usr/bin/env node
/**
 * 本地基准（任务书 §20）：不调用真实模型，全部在本机可重复跑。
 *
 *   node scripts/benchmark.mjs                  # 默认规模
 *   node scripts/benchmark.mjs --turns 2000     # 指定轮数
 *   node scripts/benchmark.mjs --mode live --smoke
 *
 * 输出：控制台表格 + artifacts/benchmarks/<时间戳>.json（供验收报告引用）。
 * 只写临时目录与 artifacts/，不碰真实数据目录。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'local'
const smoke = args.includes('--smoke')
const turns = Math.max(10, Math.min(20000, argValue('--turns', smoke ? 200 : 1000)))

const { resolveConfig } = await import('../lib/config.js')
const { PRESETS } = await import('../lib/domain/affect-reducer.js')
const { openDatabase } = await import('../lib/storage/database.js')
const { migrate } = await import('../lib/storage/migrations.js')
const { Repositories } = await import('../lib/storage/repositories.js')
const { FactUpdater } = await import('../lib/memory/fact-updater.js')
const { Retriever } = await import('../lib/memory/retriever.js')
const { buildContext, PromptStore } = await import('../lib/runtime/context-builder.js')
const { measureAndFit } = await import('../lib/runtime/context-budget.js')
const { initialSnapshot } = await import('../lib/domain/affect-reducer.js')

const config = resolveConfig({})

// live 模式需要真实模型端点，凭据只从环境变量读（不写进仓库、不读 profile 里的密钥）。
// 缺凭据时如实记 NOT_RUN，不伪造数字。
if (mode === 'live') {
  const code = await runLive()
  process.exit(code)
}

const T0 = 1_760_000_000_000
const dir = mkdtempSync(join(tmpdir(), 'companion-bench-'))
const db = openDatabase({ ...config.storage, directory: dir }, true)
migrate(db, { now: T0 })
const repos = new Repositories(db)
repos.ensureCompanion('dafeiyu', '大肥鱼', PRESETS.balanced, T0)
const principal = repos.ensurePrincipal('p-bench', 'dafeiyu', 'bot-bench', 'user-bench', T0)
repos.ensureConversation('c-bench', principal.id, 'private', 'private:bench', T0)

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const percentiles = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 }
}

const ingest = []
const updater = new FactUpdater(repos, config.memory)
for (let index = 0; index < turns; index += 1) {
  const started = now()
  const id = `m-${index}`
  repos.insertRawMessage({
    id,
    conversationId: 'c-bench',
    platformMessageKey: `bench-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    sourceKind: 'bench',
    content: index % 2 === 0 ? `第 ${index} 轮：今天加班到很晚，项目又延期了` : `第 ${index} 轮：知道了，先睡吧`,
    occurredAtMs: T0 + index * 1000,
    observedAtMs: T0 + index * 1000,
    deliveryStatus: 'delivered',
    deletedAtMs: null,
  })
  if (index % 20 === 0) {
    updater.write({
      id: `mem-${index}`,
      principalId: principal.id,
      conversationId: 'c-bench',
      visibility: 'private',
      kind: 'fact',
      subject: `主题${index % 50}`,
      predicate: '内容',
      object: { value: index },
      claim: `第 ${index} 轮记录：项目延期，加班到很晚`,
      sourceKind: 'bench',
      confidence: 0.8,
      salience: 0.6,
      eventAtMs: T0 + index * 1000,
      observedAtMs: T0 + index * 1000,
      evidence: [{ messageId: id, quote: '项目又延期了' }],
    })
  }
  ingest.push(now() - started)
}

const retriever = new Retriever(repos, config.memory)
const binding = {
  companionId: 'dafeiyu',
  botAccountId: 'bot-bench',
  userId: 'user-bench',
  conversationId: 'c-bench',
  conversationKind: 'private',
  principalId: principal.id,
  visibility: 'private',
}
const retrieval = []
const queries = ['你还记得我项目延期的事吗', '最近加班怎么样', '我之前说过住哪', '今天好累']
for (let index = 0; index < Math.min(turns, 300); index += 1) {
  const started = now()
  retriever.retrieve({ binding, query: queries[index % queries.length], nowMs: T0 + index * 1000 })
  retrieval.push(now() - started)
}

const snapshot = initialSnapshot(principal.id, 'balanced', config.affect.ruleVersion, T0)
const prompts = new PromptStore()
const persona = prompts.persona('balanced')
const protocol = prompts.protocol()
const assembly = []
for (let index = 0; index < Math.min(turns, 200); index += 1) {
  const started = now()
  const selected = retriever.retrieve({ binding, query: queries[index % queries.length], nowMs: T0 }).selected
  buildContext({
    persona,
    protocol,
    boundaries: '私聊；当前没有约定中的事情',
    snapshot,
    recent: [
      { id: `bench-${index}-u`, text: '今天加班到十点', role: 'user' },
      { id: `bench-${index}-a`, text: '又加班？', role: 'assistant' },
    ],
    memoryItems: selected,
    checkpoint: '',
    memoryConfig: config.memory,
  })
  assembly.push(now() - started)
}

const dbBytes = repos.databaseBytes()
const result = {
  generatedAt: new Date().toISOString(),
  mode,
  turns,
  memories: repos.counts().memories,
  messages: repos.counts().raw_messages,
  dbBytes,
  ingest: { ...percentiles(ingest), totalMs: ingest.reduce((sum, value) => sum + value, 0) },
  retrieval: percentiles(retrieval),
  assembly: percentiles(assembly),
  targets: {
    retrievalP95Ms: config.memory.retrievalDeadlineMs,
    note: '检索超过 deadline 视为超时；装配耗时不计模型调用',
  },
}

mkdirSync(join(root, 'artifacts', 'benchmarks'), { recursive: true })
const outFile = join(root, 'artifacts', 'benchmarks', `${result.generatedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log(`benchmark（${mode}）· ${turns} 轮 · 记忆 ${result.memories} 条 · 原文 ${result.messages} 条`)
console.log('─'.repeat(62))
console.log(`写入      p50 ${result.ingest.p50.toFixed(3)}ms  p95 ${result.ingest.p95.toFixed(3)}ms`)
console.log(`检索      p50 ${result.retrieval.p50.toFixed(3)}ms  p95 ${result.retrieval.p95.toFixed(3)}ms  (目标 <${config.memory.retrievalDeadlineMs}ms)`)
console.log(`装配      p50 ${result.assembly.p50.toFixed(3)}ms  p95 ${result.assembly.p95.toFixed(3)}ms`)
console.log(`数据库    ${(dbBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`报告      ${outFile}`)

db.close()
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
} catch {
  /* 临时目录留给系统清理 */
}

const overBudget = result.retrieval.p95 > config.memory.retrievalDeadlineMs
if (overBudget) {
  console.error(`检索 p95 超过 deadline（${config.memory.retrievalDeadlineMs}ms）`)
  process.exit(1)
}

/**
 * live 模式：真实模型调用，测量首 token 与整段延迟。
 * 必须显式提供凭据；默认样本很少（smoke 3 次），不做大规模烧钱。
 * 退出码：0 全部成功 / 1 有失败样本 / 3 NOT_RUN（缺凭据）。
 */
async function runLive() {
  const baseUrl = (process.env.DSH_BENCH_LIVE_BASE_URL ?? '').replace(/\/+$/, '')
  const apiKey = process.env.DSH_BENCH_LIVE_API_KEY ?? ''
  const model = process.env.DSH_BENCH_LIVE_MODEL ?? ''
  const samples = Math.max(1, Math.min(50, argValue('--samples', smoke ? 3 : 10)))
  const prompt = process.env.DSH_BENCH_LIVE_PROMPT ?? '用一句话回答：今天适合加班吗？'
  const record = {
    generatedAt: new Date().toISOString(),
    mode: 'live',
    smoke,
    samples,
    model: model || null,
    endpoint: baseUrl ? `${baseUrl}（已配置）` : null,
    prompt,
    results: [],
    status: 'NOT_RUN',
    note: 'live 模式只测模型链路延迟，不含 QQ 发送；凭据通过环境变量注入，不落盘。'
  }

  if (!baseUrl || !apiKey || !model) {
    console.log('benchmark（live）· NOT_RUN')
    console.log('─'.repeat(62))
    console.log('缺少凭据：请设置 DSH_BENCH_LIVE_BASE_URL / DSH_BENCH_LIVE_API_KEY / DSH_BENCH_LIVE_MODEL')
    console.log('示例（OpenAI 兼容端点）：')
    console.log('  $env:DSH_BENCH_LIVE_BASE_URL="https://example.com/v1"; $env:DSH_BENCH_LIVE_MODEL="deepseek-v4.1-flash"; $env:DSH_BENCH_LIVE_API_KEY="…"')
    console.log('  node scripts/benchmark.mjs --mode live --smoke')
    record.reason = 'missing-credentials'
  } else {
    for (let index = 0; index < samples; index += 1) {
      const started = now()
      let firstToken = null
      let text = ''
      let usage = null
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true, stream_options: { include_usage: true } })
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}：${(await response.text()).slice(0, 200)}`)
        const decoder = new TextDecoder()
        let buffer = ''
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true })
          let boundary = buffer.indexOf('\n')
          while (boundary >= 0) {
            const line = buffer.slice(0, boundary).trim()
            buffer = buffer.slice(boundary + 1)
            boundary = buffer.indexOf('\n')
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) {
              if (firstToken === null) firstToken = now() - started
              text += delta
            }
            if (parsed.usage) usage = parsed.usage
          }
        }
        record.results.push({
          index,
          ok: true,
          firstTokenMs: firstToken,
          totalMs: now() - started,
          chars: text.length,
          usage: usage ? { input: usage.prompt_tokens ?? null, output: usage.completion_tokens ?? null } : null
        })
      } catch (error) {
        record.results.push({ index, ok: false, error: String(error?.message ?? error), totalMs: now() - started })
      }
    }
    const ok = record.results.filter((item) => item.ok)
    record.status = ok.length === samples ? 'PASS' : 'FAIL'
    const firsts = ok.map((item) => item.firstTokenMs).filter((value) => typeof value === 'number')
    const totals = ok.map((item) => item.totalMs)
    const pct = (values) => {
      const sorted = [...values].sort((a, b) => a - b)
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
      return { p50: at(0.5), p95: at(0.95) }
    }
    record.summary = {
      samples: ok.length,
      failures: samples - ok.length,
      firstToken: firsts.length > 0 ? pct(firsts) : null,
      total: totals.length > 0 ? pct(totals) : null,
      note: '样本数很小，只作链路可用性参考，不能当作容量结论。'
    }
    console.log(`benchmark（live·${smoke ? 'smoke' : 'full'}）· ${samples} 次 · 模型 ${model}`)
    console.log('─'.repeat(62))
    if (firsts.length > 0) console.log(`首 token  p50 ${pct(firsts).p50.toFixed(0)}ms  p95 ${pct(firsts).p95.toFixed(0)}ms`)
    if (totals.length > 0) console.log(`整段     p50 ${pct(totals).p50.toFixed(0)}ms  p95 ${pct(totals).p95.toFixed(0)}ms`)
    console.log(`成功 ${ok.length}/${samples}${ok.length === samples ? '' : '（失败样本见报告）'}`)
  }

  mkdirSync(join(root, 'artifacts', 'benchmarks'), { recursive: true })
  const outFile = join(root, 'artifacts', 'benchmarks', `live-${record.generatedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`报告      ${outFile}`)
  if (record.status === 'NOT_RUN') return 3
  return record.status === 'PASS' ? 0 : 1
}
