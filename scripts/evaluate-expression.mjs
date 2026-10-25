import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { initialSnapshot } from '../lib/domain/affect-reducer.js'
import { composePersonality } from '../lib/domain/personality-profile.js'
import { projectExpression } from '../lib/domain/expression-plan.js'
import { evaluateTurn } from './evaluation-session.mjs'
const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const mode = arg('mode', 'fake'), split = arg('split', 'development')
const variant = arg('variant', 'full')
if (!['baseline', 'prompt', 'full'].includes(variant)) throw new Error('Expected --variant=baseline|prompt|full')
const root = path.resolve(variant === 'full' ? '.' : arg('baseline-root', 'dist/dsh-companion-memory-0.2.0'))
if (!fs.existsSync(path.join(root, 'lib/runtime/turn-coordinator.js'))) throw new Error('Baseline release directory is missing; pass --baseline-root=PATH')
if (!['fake', 'live'].includes(mode) || !['development', 'acceptance'].includes(split)) throw new Error('Expected --mode=fake|live --split=development|acceptance')
const budget = Number(arg('max-calls', '60')), maxTokens = Number(arg('max-tokens', '400'))
if (!Number.isInteger(budget) || budget < 1 || !Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('Invalid evaluation budget')
const dataset = JSON.parse(fs.readFileSync('tests/fixtures/v03/expression-cases.json', 'utf8'))
const adapterPath = arg('adapter', '')
if (mode === 'live' && !adapterPath) throw new Error('Live evaluation requires an explicit local adapter module exporting generate({system,user,maxTokens,seed})')
const adapter = mode === 'live' ? await import(pathToFileURL(path.resolve(adapterPath))) : null
if (adapter && typeof adapter.generate !== 'function') throw new Error('Adapter must export generate')
if (adapter && (!adapter.metadata || typeof adapter.metadata.provider !== 'string' || typeof adapter.metadata.model !== 'string')) throw new Error('Live adapter must export metadata.provider and metadata.model')
const model = adapter ? { provider: adapter.metadata.provider, model: adapter.metadata.model, version: adapter.metadata.version ?? 'unknown', temperature: adapter.metadata.temperature ?? 'unknown' } : 'scripted'
const results = []
let calls = 0
for (const item of dataset.cases.filter(x => x.split === split).slice(0, budget)) {
  if (calls >= budget) break
  const state = initialSnapshot(item.id, 'balanced', 'affect-v1', item.nowMs)
  for (const key of ['anger', 'hurt', 'joy', 'tension']) state.mood[key] = item.stateBefore[key]
  for (const key of ['trust', 'familiarity']) state.relationship[key] = item.stateBefore[key]
  const profile = composePersonality({ companionId: 'eval', personaId: item.id, nowMs: item.nowMs, options: { mix: item.personaMix, overrides: item.traitsOverrides, variation: { enabled: false, maxDelta: .05, seed: null } } })
  if (variant === 'full') Object.assign(state.personality, Object.fromEntries(Object.keys(state.personality).map(key => [key, profile.traits[key]])))
  const plan = projectExpression({ state, profile, userText: item.userInput, nowMs: item.nowMs })
  const started = performance.now()
  const outcome = await evaluateTurn({ root, variant, item, state, generate: async request => {
    if (calls >= budget) throw new Error('Evaluation model call budget exhausted')
    calls++
    return adapter ? adapter.generate({ ...request, maxTokens, seed: dataset.seed }) : { text: '<say>这是一条验证管线使用的合成回复。</say>', usage: null }
  } })
  results.push({ id: item.id, mode, variant, split, input: item.userInput, referencePlan: plan, ...outcome, latencyMs: performance.now() - started, humanRatings: null })
}
const output = path.resolve(arg('output', 'artifacts/v03-expression-evaluation.json'))
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify({ mode, variant, model, calls, datasetVersion: dataset.version, seed: dataset.seed, results, qualityVerified: false, note: mode === 'fake' ? 'Actual coordinator, scripted model; no real model or human quality evidence' : 'Actual coordinator outputs require independent blind human review' }, null, 2))
console.log(JSON.stringify({ output, cases: results.length, calls, mode, variant, qualityVerified: false }))
