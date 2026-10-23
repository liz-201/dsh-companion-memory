import { initialSnapshot, projectSnapshot, reduce } from './affect-reducer.js';
import { emptyDelta } from './episode-manager.js';
import { scaleEffect } from './event-policy.js';
import { partsInZone, zonedToUtc } from './time-parse.js';
function payload(row) {
    return JSON.parse(String(row['payload_json']));
}
function dayKey(atMs, timezone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(atMs);
}
export function dailyUsage(rows, nowMs, config) {
    const used = emptyDelta();
    const timezone = config.proactive.timezone;
    const parts = partsInZone(nowMs, timezone);
    const start = zonedToUtc(parts.year, parts.month, parts.day, 0, 0, timezone);
    const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    const end = zonedToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0, timezone);
    const baseline = initialSnapshot('', config.companion.preset, config.affect.ruleVersion, nowMs);
    for (const row of rows) {
        const at = Number(row['event_time_ms']);
        if (at < start || at >= end)
            continue;
        const event = payload(row);
        // Older records lack the applied delta. Charge their full base effect conservatively.
        const delta = event.relationshipDelta ?? scaleEffect(event.appraisal, baseline.personality, baseline.relationship, config.affect).relationship;
        for (const key of Object.keys(used))
            used[key] += Math.abs(Math.round(delta[key] * 1000) / 1000);
    }
    return used;
}
/** Replay remaining source events, preserving the current personality and explicit reset baseline. */
export function rebuildAffect(repos, config, principalId, nowMs) {
    const rows = repos.activeAffectEvents(principalId).sort((a, b) => Number(a['event_time_ms']) - Number(b['event_time_ms']) || Number(a['seq']) - Number(b['seq']));
    const stored = repos.getSnapshot(principalId);
    const baseline = repos.getSetting(`affect.baseline:${principalId}`);
    let state = baseline === undefined
        ? initialSnapshot(principalId, config.companion.preset, config.affect.ruleVersion, Number(rows[0]?.['event_time_ms'] ?? nowMs))
        : JSON.parse(baseline);
    if (stored)
        state.personality = stored.snapshot.personality;
    const episodes = new Map();
    const usage = new Map();
    const seen = new Set();
    repos.db.run("UPDATE relationship_episodes SET status = 'archived' WHERE principal_id = ?", principalId);
    for (const row of rows) {
        const event = payload(row);
        const at = Number(row['event_time_ms']);
        const key = String(row['idempotency_key']);
        const conversationId = String(row['conversation_id']);
        const day = dayKey(at, config.proactive.timezone);
        const used = usage.get(day) ?? emptyDelta();
        const result = reduce(state, { ...event.appraisal, occurredAtMs: at }, { now: () => at }, config.affect, {
            dailyUsed: used, episode: episodes.get(conversationId), fromInboundUserMessage: true,
            establishedTeasingContext: event.teasing ?? false, roleplay: event.roleplay ?? false, idempotencyKey: key, seenIdempotencyKeys: seen,
        });
        state = result.next;
        seen.add(key);
        for (const field of Object.keys(used))
            used[field] += Math.abs(result.episode.deltaToApply[field]);
        usage.set(day, used);
        if (result.episode.id !== 'none') {
            const prior = episodes.get(conversationId);
            const cumulative = emptyDelta();
            for (const field of Object.keys(cumulative))
                cumulative[field] = (prior?.id === result.episode.id ? prior.appliedDeltas[field] : 0) + result.episode.deltaToApply[field];
            episodes.set(conversationId, { ...result.episode, appliedDeltas: cumulative });
            const existing = repos.getEpisode(result.episode.id);
            repos.upsertEpisode({
                id: result.episode.id, principalId, conversationId, kind: result.episode.kind, status: result.episode.status,
                sourceMessageIds: [...new Set([...(prior?.id === result.episode.id ? existing?.sourceMessageIds ?? [] : []), event.appraisal.sourceMessageId])],
                appliedDeltas: cumulative, startedAtMs: prior?.id === result.episode.id ? existing?.startedAtMs ?? at : at,
                lastEventAtMs: at, summary: existing?.summary ?? result.episode.kind,
            }, existing === undefined);
        }
        repos.db.run('UPDATE affect_events SET payload_json = ? WHERE seq = ?', JSON.stringify({ ...event, relationshipDelta: result.episode.deltaToApply }), row['seq']);
    }
    return { ...projectSnapshot(state, nowMs, config.affect), revision: (stored?.revision ?? 0) + 1, projectedThroughSeq: Number(rows.at(-1)?.['seq'] ?? 0) };
}
//# sourceMappingURL=affect-projector.js.map