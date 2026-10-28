import { humanSourceSql } from '../memory/source-policy.js';
/** One upgrade pass; terminal protocol failures are not reset every restart. */
export function recoverConsolidationJobs(repos, nowMs) {
    if (repos.getSetting('local.consolidation.protocol') === '2')
        return 0;
    return repos.db.transaction(() => {
        const recovered = repos.db.run("UPDATE background_jobs SET status = 'pending', attempts = 0, lease_until_ms = NULL, available_at_ms = ? WHERE kind = 'consolidate' AND status = 'failed' AND (last_error LIKE '%整理输出%' OR last_error LIKE '%changes%') AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = json_extract(background_jobs.payload_json, '$.conversationId'))", nowMs).changes;
        repos.setSetting('local.consolidation.protocol', '2', nowMs);
        return recovered;
    });
}
/** Count persisted user messages, independent of who generated the visible reply. */
export function scheduleConsolidation(repos, config, background, conversationId, principalId, nowMs, options = {}) {
    if (conversationId.startsWith('review:') || config.background.consolidateEveryTurns <= 0)
        return false;
    const cursor = Number(repos.getSetting(`consolidation.cursor:${conversationId}`) ?? 0);
    const pending = repos.db.get(`SELECT COUNT(*) AS n, MAX(seq) AS last FROM raw_messages WHERE conversation_id = ? AND ${humanSourceSql()} AND seq > ?`, conversationId, cursor);
    const continuing = options.throughSeq !== undefined && options.throughSeq > cursor;
    if (!continuing && (pending?.n ?? 0) < config.background.consolidateEveryTurns)
        return false;
    if (repos.db.get("SELECT id FROM background_jobs WHERE kind = 'consolidate' AND status IN ('pending', 'leased') AND json_extract(payload_json, '$.conversationId') = ? AND id <> ? LIMIT 1", conversationId, options.excludeJobId ?? ''))
        return false;
    const throughSeq = Math.max(options.throughSeq ?? 0, pending?.last ?? 0);
    const fragment = repos.getSetting(`local.consolidation.fragment:${conversationId}`) ?? '';
    return background.enqueue('consolidate', { conversationId, principalId, afterSeq: cursor, throughSeq }, {
        dedupKey: `consolidate:messages:${conversationId}:${cursor}:${throughSeq}:${fragment}`,
        principalId, availableAtMs: nowMs + 1000, nowMs,
    });
}
//# sourceMappingURL=consolidation-scheduler.js.map