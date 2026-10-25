import { createHash } from 'node:crypto';
/** Store observed appraisals separately from later interpretations; never turn them into new evidence. */
export function annotateEpisode(repos, principalId, appraisal, nowMs) {
    const raw = repos.getRawMessage(appraisal.sourceMessageId);
    if (!raw || raw.deletedAtMs !== null || raw.role !== 'user')
        return;
    const id = createHash('sha256').update(`${principalId}:${appraisal.sourceMessageId}:${appraisal.kind}:${appraisal.revision}`).digest('hex');
    repos.db.run('INSERT OR IGNORE INTO episodic_annotations VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)', id, principalId, JSON.stringify([raw.id]), JSON.stringify(appraisal), '{}', nowMs, 'episodic-v1');
}
export function archiveMemories(repos, principalId, beforeMs) {
    return repos.db.run("INSERT INTO memory_lifecycle(memory_id, archive_state, last_retrieved_ms, tombstone_event_id) SELECT id, 'archived', NULL, NULL FROM memories WHERE principal_id = ? AND observed_at_ms < ? AND kind IN ('episode','hypothesis') ON CONFLICT(memory_id) DO UPDATE SET archive_state = 'archived'", principalId, beforeMs).changes;
}
export function repairContext(repos, binding, memoryId) {
    const evidence = new Set(repos.memoryEvidence(memoryId).map(item => item.messageId));
    const episodes = repos.listEpisodes(binding.principalId, ['repairing', 'resolved'], 10).filter(episode => (binding.visibility !== 'group' || episode.conversationId === binding.conversationId) && episode.sourceMessageIds.some(id => evidence.has(id)));
    const found = [];
    for (const episode of episodes)
        for (const row of repos.db.all("SELECT json_extract(payload_json, '$.appraisal.sourceMessageId') AS message_id FROM affect_events WHERE principal_id = ? AND episode_id = ? AND status = 'active' AND json_extract(payload_json, '$.appraisal.kind') IN ('apology','reassurance','correction') ORDER BY event_time_ms DESC LIMIT 2", binding.principalId, episode.id)) {
            const id = row.message_id;
            if (evidence.has(id) || found.some(item => item.messageId === id))
                continue;
            const message = repos.getRawMessage(id);
            if (!message || message.deletedAtMs !== null || message.role !== 'user' || message.content.length > 200)
                continue;
            found.push({ messageId: id, quote: message.content });
            if (found.length >= 2)
                return found;
        }
    return found;
}
//# sourceMappingURL=episodic.js.map