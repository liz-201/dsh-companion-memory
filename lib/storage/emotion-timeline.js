import { humanSourceSql } from '../memory/source-policy.js';
import { continuousAffect } from './continuous-affect.js';
const MAX_POINTS = 30;
const MAX_REVISIONS = 16;
const SOURCE_CHARACTERS = 2000;
const VECTOR_CHARACTERS = 12000;
/** A read-only explanation rebuilt from current evidence, never a stored historical snapshot. */
export function emotionTimeline(repos, config, principalId, nowMs, requestedLimit = MAX_POINTS) {
    if (!Number.isFinite(nowMs))
        throw Error('Invalid emotion timeline time');
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(MAX_POINTS, Math.trunc(requestedLimit))) : MAX_POINTS;
    const selected = repos.db.all(`SELECT r.id,r.conversation_id,r.seq,r.occurred_at_ms,r.content FROM raw_messages r
     JOIN conversations c ON c.id=r.conversation_id
     WHERE c.principal_id=? AND c.kind='private' AND ${humanSourceSql('r')} AND r.occurred_at_ms<=?
     ORDER BY r.occurred_at_ms DESC,r.seq DESC,r.id DESC LIMIT ?`, principalId, nowMs, limit + 1);
    const hasMore = selected.length > limit;
    const sources = selected.slice(0, limit).reverse();
    const timeline = { version: 'emotion-timeline-v1', projection: 'current-valid-evidence', sameTimeRule: 'whole-millisecond', generatedAtMs: nowMs, limit, hasMore, points: [] };
    if (!sources.length)
        return timeline;
    const placeholders = sources.map(() => '?').join(',');
    const appraisals = repos.db.all(`SELECT a.id,a.source_message_id,a.slot,a.revision,a.status,a.evidence_quote,a.vector_json FROM emotion_appraisals a
     JOIN raw_messages r ON r.id=a.source_message_id JOIN conversations c ON c.id=r.conversation_id
     WHERE a.principal_id=? AND c.principal_id=? AND c.kind='private' AND a.conversation_id=r.conversation_id
       AND ${humanSourceSql('r')} AND r.id IN (${placeholders})
     ORDER BY a.source_message_id,a.slot,a.id`, principalId, principalId, ...sources.map(row => row.id));
    const revisions = appraisals.length ? repos.db.all(`SELECT id,appraisal_id,revision,status,vector_json,recorded_at_ms,total FROM (
       SELECT v.*,COUNT(*) OVER(PARTITION BY v.appraisal_id) AS total,
         ROW_NUMBER() OVER(PARTITION BY v.appraisal_id ORDER BY v.revision DESC,v.recorded_at_ms DESC,v.id DESC) AS position
       FROM emotion_appraisal_revisions v WHERE v.appraisal_id IN (${appraisals.map(() => '?').join(',')})
     ) WHERE position<=? ORDER BY appraisal_id,revision,recorded_at_ms,id`, ...appraisals.map(row => row.id), MAX_REVISIONS) : [];
    const byAppraisal = new Map();
    for (const row of revisions) {
        let history = byAppraisal.get(row.appraisal_id);
        if (!history) {
            history = { rows: [], total: Number(row.total) };
            byAppraisal.set(row.appraisal_id, history);
        }
        history.rows.push({ id: row.id, revision: row.revision, status: row.status, recordedAtMs: row.recorded_at_ms, vectorJson: row.vector_json.slice(0, VECTOR_CHARACTERS), vectorTruncated: row.vector_json.length > VECTOR_CHARACTERS });
    }
    const bySource = new Map();
    for (const row of appraisals) {
        const history = byAppraisal.get(row.id);
        const item = { id: row.id, revision: row.revision, status: row.status, evidenceQuote: row.evidence_quote, vectorJson: row.vector_json.slice(0, VECTOR_CHARACTERS), vectorTruncated: row.vector_json.length > VECTOR_CHARACTERS, revisions: history?.rows ?? [], revisionHistoryTotal: history?.total ?? 0, revisionHistoryTruncated: (history?.total ?? 0) > MAX_REVISIONS };
        const items = bySource.get(row.source_message_id) ?? [];
        items.push(item);
        bySource.set(row.source_message_id, items);
    }
    const states = new Map();
    const sameTimeCounts = new Map();
    for (const source of sources) {
        const at = source.occurred_at_ms;
        if (!states.has(at)) {
            states.set(at, continuousAffect(repos, config, principalId, at));
            sameTimeCounts.set(at, repos.db.get(`SELECT COUNT(*) AS n FROM raw_messages r JOIN conversations c ON c.id=r.conversation_id
         WHERE c.principal_id=? AND c.kind='private' AND ${humanSourceSql('r')} AND r.occurred_at_ms=?`, principalId, at)?.n ?? 0);
        }
        timeline.points.push({ sourceMessageId: source.id, conversationId: source.conversation_id, sourceSeq: source.seq, occurredAtMs: at, sourceText: source.content.slice(0, SOURCE_CHARACTERS), sourceTextTruncated: source.content.length > SOURCE_CHARACTERS, sameTimeSourceCount: sameTimeCounts.get(at), appraisals: bySource.get(source.id) ?? [], state: states.get(at) ?? null });
    }
    return timeline;
}
//# sourceMappingURL=emotion-timeline.js.map