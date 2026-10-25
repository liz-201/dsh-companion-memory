import type { IdentityBinding, DeliveryReceipt } from '../domain/types.js'
import type { Repositories } from '../storage/repositories.js'
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js'
interface Session { id: string; append: (type: string, data: unknown, options: unknown) => unknown; snapshotEvents: () => unknown[]; deriveMessages?: () => unknown[] }
export class DesktopDelivery {
  private targets = new Map<string, { session: Session; binding: IdentityBinding; personaId: string }>()
  private busy = new Set<string>()
  constructor(private readonly repos: Repositories) {}
  register(sessionValue: unknown, binding: IdentityBinding, personaId: string): void {
    const session = sessionValue as Partial<Session>
    if (typeof session?.id !== 'string' || typeof session.append !== 'function' || typeof session.snapshotEvents !== 'function') return
    for (const [id, target] of this.targets) if (target.session.id === session.id && id !== binding.conversationId) {
      this.targets.delete(id)
      this.repos.db.run(`UPDATE outbox SET status = 'cancelled', last_error_code = 'persona-changed' WHERE conversation_id = ? AND ${SPONTANEOUS_OUTBOX} AND status = 'pending'`, id)
      this.repos.db.run("UPDATE proactive_opportunities SET status = 'cancelled' WHERE conversation_id = ? AND status IN ('pending','selected')", id)
    }
    this.targets.set(binding.conversationId, { session: session as Session, binding, personaId })
  }
  remove(sessionId: string): void { for (const [id, target] of this.targets) if (target.session.id === sessionId) this.targets.delete(id) }
  setBusy(sessionId: string, value: boolean): void { if (value) this.busy.add(sessionId); else this.busy.delete(sessionId) }
  isBusy(conversationId: string): boolean { const target = this.targets.get(conversationId); return target ? this.busy.has(target.session.id) : false }
  list(): { conversationId: string; principalId: string }[] { return [...this.targets].map(([conversationId, target]) => ({ conversationId, principalId: target.binding.principalId })) }
  has(conversationId: string): boolean { return this.targets.has(conversationId) }
  binding(conversationId: string): IdentityBinding | null { return this.targets.get(conversationId)?.binding ?? null }
  personaText(conversationId: string): string | null {
    const messages = this.targets.get(conversationId)?.session.deriveMessages?.() as { role?: string; content?: { type?: string; text?: string }[] }[] | undefined
    const text = messages?.filter(message => message.role === 'system').flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    return text || null
  }
  async send(conversationId: string, text: string, key: string, expectedInboundSeq: number | null): Promise<DeliveryReceipt> {
    const now = Date.now(), target = this.targets.get(conversationId)
    if (!target || this.isBusy(conversationId)) return { kind: 'rejected', code: 'desktop-unavailable', atMs: now }
    const { session } = target
    const events = session.snapshotEvents() as { type?: string; data?: { agentPreset?: unknown; message?: { id?: string } } }[]
    const preset = events.findLast(event => event.type === 'agent-preset/selected')?.data?.agentPreset
    if (typeof preset === 'string' && target.personaId.startsWith('preset:') && target.personaId !== `preset:${preset}`) return { kind: 'rejected', code: 'persona-changed', atMs: now }
    if (events.some(event => event.type === 'assistant/message' && event.data?.message?.id === key)) return { kind: 'accepted', platformMessageId: key, atMs: now }
    // No await between final recheck and append: the local event loop cannot interleave inbound handling.
    if (expectedInboundSeq !== null && this.repos.latestInboundSeq(conversationId) > expectedInboundSeq) return { kind: 'rejected', code: 'user-spoke-first', atMs: now }
    session.append('assistant/message', { turn: 0, step: 0, message: { id: key, role: 'assistant', content: [{ type: 'text', text }], source: { provider: 'companion-memory', model: 'proactive' } }, stream: [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }] }, { surfaceOp: 'append' })
    return { kind: 'accepted', platformMessageId: key, atMs: now }
  }
}
