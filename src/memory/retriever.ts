/**
 * 长程记忆检索（任务书 §10.3）。
 *
 * 管线顺序是硬约束，测试按阶段断言：
 *   scope/visibility/删除/status 过滤
 *   → 查询词
 *   → 实体/别名/当前事实/全文/未结事项检索
 *   → 排名融合 + 去重 + 冲突检查
 *   → 证据展开
 *   → 预算打包（3–6 条；无相关则不注入）
 *
 * 这里不生成 FTS 语法细节（lexical-index 负责），也不做 token 计数（context-budget 负责）。
 * 所有结果都是**只读**的：检索不得改动 confidence、不得新增证据、不得写库。
 */

import type { MemoryConfig } from '../config.js'
import type { IdentityBinding, RememberedItem, Visibility } from '../domain/types.js'
import { canReadMemory } from '../domain/identity.js'
import type { MemoryRow, Repositories } from '../storage/repositories.js'
import { tokensToMatchQuery } from './normalizer.js'
import { buildQueryTerms, termWeights, type AliasDictionary } from './lexical-index.js'
import { repairContext } from './episodic.js'

export interface RetrievalRequest {
  binding: IdentityBinding
  /** 当轮用户原话（已脱敏，未截断）。 */
  query: string
  /** 当前心情的绝对唤醒度 0..1；只做 ±10–15% 的微调。 */
  emotionArousal?: number
  /** 事实型问题不叠加情绪加分。 */
  forceFactual?: boolean
  nowMs: number
  dictionary?: AliasDictionary
}

export interface ScoredMemory {
  row: MemoryRow
  item: RememberedItem
  score: number
  reasons: string[]
  channels: string[]
  /** 与另一条记忆冲突（同 subject/predicate 但值不同）。 */
  conflictsWith: string[]
}

export interface RetrievalResult {
  /** 通过过滤与打分的候选（上限 candidateLimit）。 */
  candidates: ScoredMemory[]
  /** 预算内选中的条目（3–6 条，可能为 0）。 */
  selected: ScoredMemory[]
  /** 明确被排除的条目及原因，供 /fish why 与测试使用。 */
  excluded: { id: string; reason: string }[]
  terms: { tokens: string[]; expanded: string[]; factual: boolean }
  ftsAvailable: boolean
  elapsedMs: number
}

const KIND_BONUS: Readonly<Record<string, number>> = {
  interaction_rule: 0.12,
  preference: 0.09,
  fact: 0.07,
  episode: 0.05,
  hypothesis: -0.05,
}

const SOURCE_BONUS: Readonly<Record<string, number>> = {
  owner_correction: 0.18,
  explicit_remember: 0.15,
  live_tail: 0.06,
  background: 0.03,
  consolidation: 0.02,
}

export class Retriever {
  constructor(
    private readonly repos: Repositories,
    private readonly config: MemoryConfig,
  ) {}

  retrieve(request: RetrievalRequest): RetrievalResult {
    const startedAt = performance.now()
    const terms = buildQueryTerms(request.query, request.dictionary)
    const weights = termWeights(terms)
    const excluded: { id: string; reason: string }[] = []
    const scores = new Map<string, { score: number; reasons: string[]; channels: string[] }>()

    const bump = (id: string, amount: number, reason: string, channel: string): void => {
      const current = scores.get(id) ?? { score: 0, reasons: [], channels: [] }
      current.score += amount
      if (!current.reasons.includes(reason)) current.reasons.push(reason)
      if (!current.channels.includes(channel)) current.channels.push(channel)
      scores.set(id, current)
    }

    let ftsAvailable = false
    const tokens = [...weights.keys()].filter((token) => token !== '')
    if (tokens.length > 0) {
      const matchQuery = tokensToMatchQuery(tokens.slice(0, 12), 'or')
      const hits = this.repos.searchFts(request.binding.principalId, matchQuery, this.config.candidateLimit)
      if (hits !== undefined) {
        ftsAvailable = true
        hits.forEach((hit, index) => {
          // bm25 越小越相关：用排名而非原始负值，避免不同库版本量纲差异。
          const rankScore = 1 / (1 + index * 0.35)
          bump(hit.id, 0.55 * rankScore, `fts#${index + 1}`, 'fts')
        })
      } else {
        const likeHits = this.repos.searchLike(request.binding.principalId, tokens.slice(0, 8), this.config.candidateLimit)
        likeHits.forEach((hit, index) => bump(hit.id, 0.4 / (1 + index * 0.4), 'like', 'like'))
      }
    }

    // 当前事实：同主题的活跃事实即使没有词面命中也要进入候选（用户常问「我现在住哪」）。
    const subjectHints = this.subjectHints(request.query)
    for (const subjectKey of subjectHints) {
      for (const row of this.repos.factsBySubject(request.binding.principalId, subjectKey, '')) {
        bump(row.id, 0.3, 'subject-hit', 'entity')
      }
      for (const kind of ['preference', 'interaction_rule', 'fact'] as const) {
        for (const row of this.repos.activeMemories(request.binding.principalId, [kind], this.config.candidateLimit)) {
          if (row.subject_key === subjectKey) bump(row.id, 0.22, 'subject-kind', 'entity')
        }
      }
    }

    // 未结事项与近期高显著度条目：只有「当轮话题相关」时才加权，避免每轮都把旧账翻出来。
    const candidates = [...scores.keys()]
      .map((id) => this.repos.getMemory(id))
      .filter((row): row is MemoryRow => row !== undefined)

    const scored: ScoredMemory[] = []
    for (const row of candidates) {
      if (row.status !== 'active') {
        excluded.push({ id: row.id, reason: `status:${row.status}` })
        continue
      }
      if (!canReadMemory(row.visibility as Visibility, request.binding, row.principal_id, request.binding.companionId)) {
        excluded.push({ id: row.id, reason: 'visibility' })
        continue
      }
      const base = scores.get(row.id)
      if (base === undefined) continue
      const reasons = [...base.reasons]
      let score = base.score
      const archived = this.repos.db.get<{ archive_state: string }>('SELECT archive_state FROM memory_lifecycle WHERE memory_id = ?', row.id)?.archive_state === 'archived'
      if (archived && !/以前|之前|回忆|那次|历史/.test(request.query)) { score *= .6; reasons.push('archived-lower-priority') }

      const kindBonus = KIND_BONUS[row.kind] ?? 0
      if (kindBonus !== 0) {
        score += kindBonus
        reasons.push(`kind:${row.kind}`)
      }
      const sourceBonus = SOURCE_BONUS[row.source_kind] ?? 0
      if (sourceBonus !== 0) {
        score += sourceBonus
        reasons.push(`source:${row.source_kind}`)
      }
      const evidenceCount = this.repos.memoryEvidence(row.id).length
      if (evidenceCount > 1) {
        score += Math.min(0.1, 0.03 * (evidenceCount - 1))
        reasons.push(`evidence:${evidenceCount}`)
      }
      if (this.isTimeConditioned(request.query) && row.valid_from_ms !== null) {
        score += 0.08
        reasons.push('time-conditioned')
      }
      // 显著性只做轻微加成：高显著度的旧事不该压过当轮话题。
      score += Math.min(0.08, Math.max(0, row.salience) * 0.08)

      const item = toItem(row, evidenceCount)
      if (['episode','hypothesis'].includes(row.kind)) {
        const repairs = repairContext(this.repos, request.binding, row.id)
        if (repairs.length) {
          item.claim += `\n同一事件的后续原话（勿只复述旧片段）：${JSON.stringify(repairs)}`
          item.evidenceIds.push(...repairs.map(repair => repair.messageId))
          reasons.push('repair-context')
        }
      }
      scored.push({
        row,
        item,
        score,
        reasons,
        channels: [...base.channels],
        conflictsWith: [],
      })
    }

    // 情绪加成：相关性优先，最多 ±15%；事实型查询恒为 0。
    const arousal = request.emotionArousal ?? 0
    const factual = request.forceFactual === true || terms.factual
    if (!factual && arousal > 0 && scored.length > 0) {
      const maxBonus = Math.min(.15, this.config.emotionBonusMax)
      for (const entry of scored) {
        const intensity = Math.min(1, Math.abs(entry.row.salience) + Math.abs(entry.row.confidence) * 0.5)
        const bonus = maxBonus * arousal * intensity * 0.5
        entry.score += bonus
        if (bonus > 0.001) entry.reasons.push(`emotion:+${bonus.toFixed(3)}`)
      }
    }

    scored.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
    const capped = scored.slice(0, this.config.candidateLimit)

    // 冲突检查：同 subject+predicate 不同 object 的活跃事实互相标注。
    const byKey = new Map<string, ScoredMemory[]>()
    for (const entry of capped) {
      if (entry.row.subject_key === null || entry.row.predicate_key === null) continue
      const key = `${entry.row.subject_key}|${entry.row.predicate_key}`
      const bucket = byKey.get(key) ?? []
      bucket.push(entry)
      byKey.set(key, bucket)
    }
    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue
      for (const entry of bucket) {
        for (const other of bucket) {
          if (other === entry) continue
          if (other.row.object_json === entry.row.object_json) continue
          entry.conflictsWith.push(other.row.id)
        }
        if (entry.conflictsWith.length > 0) entry.reasons.push('conflict')
      }
    }

    const selected = this.pack(capped, request)
    return {
      candidates: capped,
      selected,
      excluded,
      terms: { tokens: terms.tokens, expanded: terms.expanded, factual: terms.factual },
      ftsAvailable,
      elapsedMs: performance.now() - startedAt,
    }
  }

  /** 预算打包：少于 3 条时不硬凑；超过 selectedLimit 时按分数截断。 */
  private pack(candidates: readonly ScoredMemory[], request: RetrievalRequest): ScoredMemory[] {
    const limit = Math.max(1, this.config.selectedLimit)
    const floor = 0.12
    const picked: ScoredMemory[] = []
    let budget = this.config.retrievalAndCheckpointBudgetTokens
    // 序号先于分数：同分时保留更近的证据链。
    const ordered = [...candidates].sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.02) return b.score - a.score
      return b.row.observed_at_ms - a.row.observed_at_ms
    })
    for (const entry of ordered) {
      if (picked.length >= limit) break
      if (entry.score < floor) continue
      const cost = estimateCost(entry.item)
      if (cost > budget && picked.length >= 1) continue
      budget -= cost
      picked.push(entry)
    }
    // 「以前」「现在」这类时间条件问题，把冲突双方都带上——否则会回答成单一时点。
    if (this.isTimeConditioned(request.query)) {
      for (const entry of picked) {
        for (const otherId of entry.conflictsWith) {
          if (picked.some((item) => item.row.id === otherId)) continue
          const other = ordered.find((item) => item.row.id === otherId)
          if (other === undefined) continue
          if (picked.length >= limit + 2) break
          picked.push(other)
        }
      }
    }
    return picked
  }

  private subjectHints(query: string): string[] {
    const hints = new Set<string>()
    for (const [term, weight] of termWeights(buildQueryTerms(query)).entries()) {
      if (weight > 0.9) hints.add(term)
    }
    const normalized = query.replace(/\s+/g, '')
    for (const pronoun of ['我', '你', '他', '她']) {
      if (normalized.includes(pronoun)) hints.add(pronoun)
    }
    return [...hints].slice(0, 4)
  }

  private isTimeConditioned(query: string): boolean {
    return /(以前|之前|原来|曾经|去年|上次|现在|后来|目前)/.test(query)
  }
}

/** 给每条记忆一个稳定的、可展示的条目（证据 id 列表补齐）。 */
export function toItem(row: MemoryRow, evidenceCount = 0): RememberedItem {
  return {
    id: row.id,
    kind: row.kind,
    claim: row.claim,
    subjectKey: row.subject_key,
    predicateKey: row.predicate_key,
    visibility: row.visibility as Visibility,
    confidence: row.confidence,
    salience: row.salience,
    validFromMs: row.valid_from_ms,
    validToMs: row.valid_to_ms,
    eventAtMs: row.event_at_ms,
    observedAtMs: row.observed_at_ms,
    evidenceIds: evidenceCount > 0 ? [`evidence:${evidenceCount}`] : [],
  }
}

/**
 * 粗估 token：中文按 1 字≈1 token，拉丁按 4 字符≈1 token。
 * 与 context-budget 的估算器保持同一口径（见该文件的 estimateTokens）。
 */
export function estimateCost(item: RememberedItem): number {
  const text = item.claim
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4) + 6
}
