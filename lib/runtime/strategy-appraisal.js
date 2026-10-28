import { checkEligibility } from '../domain/event-policy.js';
import { isHumanMessage } from '../memory/source-policy.js';
import { matchSourceQuote } from '../memory/quote-match.js';
import { EVENT_KINDS, INTENTS, TARGETS } from './output-protocol.js';
function eligible(appraisal, message, config, teasing) {
    if (appraisal.sourceMessageId !== message.id || !EVENT_KINDS.includes(appraisal.kind)
        || !INTENTS.includes(appraisal.intent) || !TARGETS.includes(appraisal.target)
        || !Number.isInteger(appraisal.severity) || appraisal.severity < 0 || appraisal.severity > 3
        || !Number.isFinite(appraisal.confidence) || appraisal.confidence < .65 || appraisal.confidence > 1)
        return false;
    if (appraisal.kind !== 'neutral' && (!appraisal.evidenceQuote || !matchSourceQuote(message.content, appraisal.evidenceQuote)))
        return false;
    if (['insult', 'teasing', 'boundary'].includes(appraisal.kind)
        && /别人说|他说|她说|引用|台词|比如|例如|假如/u.test(message.content)
        && !/我就是(?:在)?骂你|我(?:刚才)?说你/u.test(message.content))
        return false;
    return checkEligibility({ appraisal, fromInboundUserMessage: true, establishedTeasingContext: teasing, roleplay: false }, config).eligible;
}
/** QQ pre-evaluation is a cue only; the foreground tail remains the sole legacy settlement. */
export function observationStrategyAppraisals(payload, message) {
    return payload.e.map((event, revision) => ({
        sourceMessageId: message.id, kind: event.k, intent: event.i, target: event.to,
        severity: event.s, confidence: event.c, evidenceQuote: message.content.slice(0, 100),
        source: 'background', revision,
    }));
}
/** Read only this exact live source; a previous message's apology must never color this reply. */
export function currentStrategyAppraisal(repos, binding, message, config, transient = [], teasing = false) {
    const current = repos.getRawMessage(message.id);
    const owner = repos.db.get('SELECT principal_id FROM conversations WHERE id=?', message.conversationId);
    if (!current || !isHumanMessage(current) || current.content !== message.content || current.conversationId !== binding.conversationId
        || owner?.principal_id !== binding.principalId)
        return undefined;
    const rows = repos.listAppraisalsForSource(message.id).filter(row => row['status'] === 'active').map(row => ({
        sourceMessageId: message.id, kind: row['kind'], intent: row['intent'], target: row['target'],
        severity: row['severity'], confidence: row['confidence'], evidenceQuote: row['evidence_quote'] ?? undefined,
        source: row['producer'] === 'live_tail' ? 'live_tail' : 'background', revision: row['revision'],
    }));
    const priority = (a) => a.intent === 'repair' || a.kind === 'apology' ? 0
        : a.kind === 'appreciation' || a.intent === 'playful' ? 1 : a.kind === 'neutral' ? 3 : 2;
    return [...rows, ...transient].filter(a => eligible(a, current, config, teasing))
        .sort((a, b) => priority(a) - priority(b) || b.revision - a.revision)[0];
}
//# sourceMappingURL=strategy-appraisal.js.map