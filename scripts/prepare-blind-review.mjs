import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const arg = (key, fallback = '') => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const seed = arg('seed', 'v03-blind-review-1')
const runs = Object.fromEntries(['baseline', 'prompt', 'full'].map(variant => {
  const file = arg(variant)
  if (!file) throw new Error(`Missing --${variant}=evaluation.json`)
  const run = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (run.mode !== 'live' || run.variant !== variant || run.results.some(row => row.split !== 'acceptance')) throw new Error('Blind quality review requires actual live acceptance-set runs; fake/development outputs are rejected')
  return [variant, run]
}))
if (new Set(Object.values(runs).map(run => JSON.stringify(run.model))).size !== 1) throw new Error('Model settings differ between runs')
const maps = Object.fromEntries(Object.entries(runs).map(([variant, run]) => [variant, new Map(run.results.map(row => [row.id, row]))]))
const ids = [...maps.full.keys()].sort()
if (ids.length !== 180 || new Set(ids).size !== 180 || ['baseline', 'prompt'].some(variant => maps[variant].size !== ids.length || ids.some(id => !maps[variant].has(id)))) throw new Error('Require the same 180 unique locked cases in all three runs')
const output = path.resolve(arg('output', 'artifacts/v03-blind-review'))
fs.mkdirSync(output, { recursive: true })
const key = [], cases = []
for (const comparator of ['baseline', 'prompt']) for (const id of ids) {
  const flip = crypto.createHash('sha256').update(`${seed}:${comparator}:${id}`).digest()[0] % 2 === 1
  const variants = flip ? ['full', comparator] : [comparator, 'full']
  const caseId = crypto.createHash('sha256').update(`${comparator}:${id}`).digest('hex').slice(0, 16)
  cases.push({ caseId, input: maps.full.get(id).input, A: maps[variants[0]].get(id).output, B: maps[variants[1]].get(id).output })
  key.push({ caseId, originalCaseId: id, A: variants[0], B: variants[1] })
}
const columns = ['caseId', 'candidate', 'naturalness', 'personality', 'emotion', 'reliability', 'proactivity', 'preferred_A_B_or_tie', 'notes']
const csv = [columns.join(','), ...cases.flatMap(item => ['A', 'B'].map(label => `${item.caseId},${label},,,,,,,`))].join('\n') + '\n'
for (let reviewer = 1; reviewer <= 3; reviewer++) fs.writeFileSync(path.join(output, `reviewer-${reviewer}.csv`), csv)
fs.writeFileSync(path.join(output, 'cases.json'), JSON.stringify({ seed, cases }, null, 2))
fs.writeFileSync(path.join(output, 'answer-key.json'), JSON.stringify({ seed, key }, null, 2))
console.log(JSON.stringify({ output, pairs: cases.length, reviewers: 3, warning: 'Keep answer-key.json hidden until independent ratings are complete; no ratings have been generated' }))
