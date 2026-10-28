import { createHash } from 'node:crypto'
import type { Repositories } from '../storage/repositories.js'
import type { IdentityBinding, RawMessage } from '../domain/types.js'
import { partsInZone } from '../domain/time-parse.js'
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js'
import { isHumanMessage } from '../memory/source-policy.js'

export type FeedbackKind = 'positive' | 'negative' | 'busy' | 'explicit_preference' | 'unrelated' | 'unknown'
export function classifyFeedback(text: string): FeedbackKind {
  if (/现在忙|正在忙|稍后再聊|等会再说/.test(text)) return 'busy'
  if (/以后别(?:再)?发|不要再分享|别主动找我|先别主动|暂时不要主动/.test(text)) return 'explicit_preference'
  if (/这个(?:分享|话题|东西)?(?:很|挺|真)?(?:有意思|有用|不错|喜欢)|谢谢.{0,8}(?:分享|记得)|你还记得/.test(text)) return 'positive'
  if (/这个(?:话题|分享)?(?:没意思|不喜欢|不感兴趣)|别发这种/.test(text)) return 'negative'
  return 'unknown'
}
export function observeFeedback(repos: Repositories, binding: IdentityBinding, message: RawMessage): void {
  if (!isHumanMessage(message)) return
  const ownerPrivate = binding.conversationKind === 'private' && binding.principalId.includes(':owner:')
  const kind = /比如|引用|台词|假如|[“「]/.test(message.content) ? 'unrelated' : classifyFeedback(message.content)
  if (ownerPrivate && kind === 'explicit_preference' && /别主动找我|先别主动|暂时不要主动/.test(message.content)) {
    repos.setSetting('proactive.enabled', '0', message.observedAtMs)
    repos.db.run(`UPDATE outbox SET status = 'cancelled' WHERE ${SPONTANEOUS_OUTBOX} AND status = 'pending'`)
  }
  // Respect present user intent even when there is no prior delivery to rate.
  if (kind === 'busy') repos.setSetting(`proactive.snooze-until:${binding.principalId}`, String(message.observedAtMs + 60 * 60_000), message.observedAtMs)
  const row = repos.db.get<{ id: string; opportunity_id: string | null }>("SELECT id, opportunity_id FROM outbox WHERE conversation_id = ? AND turn_id IS NULL AND status = 'sent' AND sent_at_ms <= ? AND sent_at_ms >= ? ORDER BY sent_at_ms DESC LIMIT 1", binding.conversationId, message.observedAtMs, message.observedAtMs - 48 * 60 * 60_000)
  if (!row?.opportunity_id) return
  const id = createHash('sha256').update(`${row.id}:${message.id}`).digest('hex')
  repos.db.run('INSERT OR IGNORE INTO proactive_feedback VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)', id, row.opportunity_id, row.id, binding.principalId, message.id, kind, kind === 'unknown' ? null : message.content, kind === 'unknown' ? 0 : .8, 'feedback-v1', message.observedAtMs)
  // The affect observer owns emotional event eligibility. This path never awards relationship points.
  if (kind === 'explicit_preference' && /(?:别|不要).{0,6}(?:发|分享)/.test(message.content)) {
    const category = row.opportunity_id.split(':')[1]
    const opportunity = repos.db.get<{ source_ids_json: string }>('SELECT source_ids_json FROM proactive_opportunities WHERE id = ?', row.opportunity_id)
    if (/这种|这个/.test(message.content) && opportunity) for (const sourceId of JSON.parse(opportunity.source_ids_json) as string[]) repos.setSetting(`proactive.blocked-source:${binding.principalId}:${sourceId}`, message.id, message.observedAtMs)
    else if (category && !/这种|这个/.test(message.content)) repos.setSetting(`proactive.blocked-kind:${binding.principalId}:${category}`, message.id, message.observedAtMs)
  }
}
export function topicAcceptance(repos: Repositories, principalId: string, category: string, nowMs: number, timezone: string): number {
  const bucket = Math.floor(partsInZone(nowMs, timezone).hour / 6)
  const rows = repos.db.all<{ id: string; kind: FeedbackKind; opportunity_id: string; created_at_ms: number; user_message_id: string | null }>('SELECT id, kind, opportunity_id, created_at_ms, user_message_id FROM proactive_feedback f WHERE principal_id = ? AND NOT EXISTS (SELECT 1 FROM proactive_feedback replacement WHERE replacement.supersedes_id = f.id) ORDER BY created_at_ms, id', principalId).filter(row => (row.user_message_id === null || repos.getRawMessage(row.user_message_id)?.deletedAtMs === null) && row.opportunity_id.split(':')[1] === category && Math.floor(partsInZone(row.created_at_ms, timezone).hour / 6) === bucket)
  return feedbackAcceptance(rows)
}
export function feedbackAcceptance(rows: readonly { kind: FeedbackKind }[]): number {
  let positive = 0, negative = 0, value = .5
  for (const row of rows) {
    if (row.kind === 'positive') positive++
    if (row.kind === 'negative') negative++
    if (positive + negative >= 5) { const raw = (positive + 2) / (positive + negative + 4); value += Math.max(-.05, Math.min(.05, raw - value)) }
  }
  return value
}
