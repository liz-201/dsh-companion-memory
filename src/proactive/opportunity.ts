import { createHash } from 'node:crypto'
import type { Repositories } from '../storage/repositories.js'
import type { IdentityBinding, RawMessage } from '../domain/types.js'
import { computerEvidence } from './computer-evidence.js'
import { isHumanMessage } from '../memory/source-policy.js'

export type OpportunityKind = 'follow_up' | 'interest_share' | 'positive_revisit' | 'shared_topic' | 'repair' | 'reminder' | 'computer_event'
export function opportunityScore(scores: Record<string, number>): number {
  return (scores['relevance'] ?? 0) * .30 + (scores['novelty'] ?? .3) * .20 + (scores['continuation'] ?? scores['openness'] ?? 0) * .15 + (scores['acceptance'] ?? .5) * .15 + (scores['initiative'] ?? .5) * .10 + (scores['willingness'] ?? .5) * .10 - (scores['interruption'] ?? .5) * .35 - (scores['repetition'] ?? 0) * .25
}
export function addOpportunity(repos: Repositories, input: { binding: IdentityBinding; kind: OpportunityKind; summary: string; sourceIds: string[]; nowMs: number; notBeforeMs: number; expiresAtMs: number; scores?: Record<string, number>; topicRevision?: string }): string {
  if (!input.sourceIds.length || input.summary.length > 2000 || input.expiresAtMs <= input.notBeforeMs) throw new Error('Invalid opportunity evidence or window')
  for (const id of input.sourceIds) {
    const message = repos.getRawMessage(id), memory = repos.getMemory(id)
    if (!(message && isHumanMessage(message) && message.conversationId === input.binding.conversationId) && !(memory && memory.principal_id === input.binding.principalId && memory.status === 'active' && memory.visibility === input.binding.visibility) && !computerEvidence(repos, id, input.binding.principalId, input.binding.conversationId, input.nowMs)) throw new Error('Opportunity evidence is deleted or outside scope')
  }
  const topic = createHash('sha256').update(`${input.kind}:${[...input.sourceIds].sort().join(':')}:${input.topicRevision ?? ''}`).digest('hex')
  const id = `op:${input.kind}:${input.binding.principalId}:${topic}`
  repos.db.run("INSERT OR IGNORE INTO proactive_opportunities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)", id, input.binding.principalId, repos.getSetting(`persona.id:${input.binding.principalId}`) ?? 'builtin', input.binding.conversationId, input.kind, JSON.stringify(input.sourceIds), topic, input.summary, input.nowMs, input.notBeforeMs, input.expiresAtMs, repos.latestInboundSeq(input.binding.conversationId), JSON.stringify(input.scores ?? { relevance: .9, novelty: .6, continuation: .8, interruption: .4 }))
  return id
}
/** Deterministic explicit follow-up cues only; nothing is inferred from mere silence. */
export function observeOpportunity(repos: Repositories, binding: IdentityBinding, message: RawMessage): void {
  if (!isHumanMessage(message) || /比如|台词|假如|[“「]/.test(message.content)) return
  const text = message.content
  if (/(?:明天|待会|一会|稍后|今天).{0,25}(?:面试|考试|比赛|发布|演出|看结果)/.test(text)) {
    const delay = text.includes('明天') ? 30 * 60 * 60_000 : 3 * 60 * 60_000
    addOpportunity(repos, { binding, kind: 'follow_up', summary: `对方此前说：${text.slice(0, 300)}。到合适时候可问后续，不假定结果。`, sourceIds: [message.id], nowMs: message.observedAtMs, notBeforeMs: message.observedAtMs + delay, expiresAtMs: message.observedAtMs + delay + 48 * 60 * 60_000 })
  } else if (/我.{0,12}(?:通过了|考上了|拿到offer|获奖了|成功了)/i.test(text)) addOpportunity(repos, { binding, kind: 'positive_revisit', summary: `对方的好消息：${text.slice(0, 300)}。可以具体接续，不编庆祝计划。`, sourceIds: [message.id], nowMs: message.observedAtMs, notBeforeMs: message.observedAtMs + 6 * 60 * 60_000, expiresAtMs: message.observedAtMs + 48 * 60 * 60_000 })
  else if (/(?:回头|下次|改天|有空).{0,15}(?:再|继续)(?:聊|讨论)/.test(text)) addOpportunity(repos, { binding, kind: 'shared_topic', summary: `对方明确留下的待续话题：${text.slice(0, 300)}。自然接续，不假定出现新进展。`, sourceIds: [message.id], nowMs: message.observedAtMs, notBeforeMs: message.observedAtMs + 6 * 3600000, expiresAtMs: message.observedAtMs + 7 * 86400000 })
}
