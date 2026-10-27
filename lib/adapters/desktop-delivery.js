import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js';
export class DesktopDelivery {
    repos;
    targets = new Map();
    busy = new Set();
    constructor(repos) {
        this.repos = repos;
    }
    register(sessionValue, binding, personaId) {
        const session = sessionValue;
        if (typeof session?.id !== 'string' || typeof session.append !== 'function' || typeof session.snapshotEvents !== 'function')
            return;
        for (const [id, target] of this.targets)
            if (target.session.id === session.id && id !== binding.conversationId) {
                this.targets.delete(id);
                this.repos.db.run(`UPDATE outbox SET status = 'cancelled', last_error_code = 'persona-changed' WHERE conversation_id = ? AND ${SPONTANEOUS_OUTBOX} AND status = 'pending'`, id);
                this.repos.db.run("UPDATE proactive_opportunities SET status = 'cancelled' WHERE conversation_id = ? AND status IN ('pending','selected')", id);
            }
        this.targets.set(binding.conversationId, { session: session, binding, personaId });
    }
    remove(sessionId) { for (const [id, target] of this.targets)
        if (target.session.id === sessionId)
            this.targets.delete(id); }
    setBusy(sessionId, value) { if (value)
        this.busy.add(sessionId);
    else
        this.busy.delete(sessionId); }
    isBusy(conversationId) { const target = this.targets.get(conversationId); return target ? this.busy.has(target.session.id) : false; }
    list() { return [...this.targets.keys()].flatMap(conversationId => { const binding = this.binding(conversationId); return binding ? [{ conversationId, principalId: binding.principalId }] : []; }); }
    has(conversationId) { return this.targets.has(conversationId); }
    binding(conversationId) {
        const target = this.targets.get(conversationId);
        if (!target)
            return null;
        const identity = this.repos.db.get('SELECT c.principal_id, p.user_id FROM conversations c JOIN principals p ON p.id = c.principal_id WHERE c.id = ?', conversationId);
        // A live Desktop session survives a same-user pairing; its cached binding must follow the migrated conversation.
        return identity ? { ...target.binding, principalId: identity.principal_id, userId: identity.user_id } : null;
    }
    personaText(conversationId) {
        const messages = this.targets.get(conversationId)?.session.deriveMessages?.();
        const text = messages?.filter(message => message.role === 'system').flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
        return text || null;
    }
    async send(conversationId, text, key, expectedInboundSeq) {
        const now = Date.now(), target = this.targets.get(conversationId);
        if (!target || this.isBusy(conversationId))
            return { kind: 'rejected', code: 'desktop-unavailable', atMs: now };
        const { session } = target;
        const events = session.snapshotEvents();
        const preset = events.findLast(event => event.type === 'agent-preset/selected')?.data?.agentPreset;
        if (typeof preset === 'string' && target.personaId.startsWith('preset:') && target.personaId !== `preset:${preset}`)
            return { kind: 'rejected', code: 'persona-changed', atMs: now };
        if (events.some(event => event.type === 'assistant/message' && event.data?.message?.id === key))
            return { kind: 'accepted', platformMessageId: key, atMs: now };
        // No await between final recheck and append: the local event loop cannot interleave inbound handling.
        if (expectedInboundSeq !== null && this.repos.latestInboundSeq(conversationId) > expectedInboundSeq)
            return { kind: 'rejected', code: 'user-spoke-first', atMs: now };
        session.append('assistant/message', { turn: 0, step: 0, message: { id: key, role: 'assistant', content: [{ type: 'text', text }], source: { provider: 'companion-memory', model: 'proactive' } }, stream: [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }] }, { surfaceOp: 'append' });
        return { kind: 'accepted', platformMessageId: key, atMs: now };
    }
}
//# sourceMappingURL=desktop-delivery.js.map