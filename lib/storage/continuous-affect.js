import { createHash } from 'node:crypto';
import { parseAppraisals } from '../domain/emotion-appraisal.js';
import { classifyOcc } from '../domain/occ-classifier.js';
import { projectDrives, respondDrive } from '../domain/drive-projector.js';
import { projectPad } from '../domain/pad-projector.js';
import { matchSourceQuote } from '../memory/quote-match.js';
const cache = new WeakMap();
/** Host binds all identities and quotes; model references are restricted to the supplied owner history. */
export function saveEmotionAppraisals(repos, binding, message, candidates, producer = 'background') {
    const rows = parseAppraisals(candidates);
    return repos.db.transaction(() => {
        const owner = repos.db.get('SELECT principal_id FROM conversations WHERE id = ?', message.conversationId);
        if (owner?.principal_id !== binding.principalId || message.conversationId !== binding.conversationId || message.role !== 'user' || repos.getRawMessage(message.id)?.deletedAtMs !== null || repos.getRawMessage(message.id)?.content !== message.content)
            throw Error('Invalid emotion source owner');
        const valid = rows.map(vector => {
            const quote = matchSourceQuote(message.content, vector.quote);
            if (!quote)
                throw Error('Emotion quote is not present in source message');
            if (vector.suppliedEvidenceRef) {
                const prior = repos.db.get("SELECT a.vector_json,a.event_time_ms FROM emotion_appraisals a JOIN raw_messages r ON r.id=a.source_message_id WHERE a.id=? AND a.principal_id=? AND a.status='active' AND r.deleted_at_ms IS NULL", vector.suppliedEvidenceRef, binding.principalId);
                if (!prior || prior.event_time_ms >= message.occurredAtMs || JSON.parse(prior.vector_json).prospect !== 'pending')
                    throw Error('Invalid prior expectation reference');
            }
            const qualified = { ...vector, quote };
            if (vector.agency === 'self' && vector.focus === 'action') {
                if (!vector.suppliedBehaviorRef) {
                    delete qualified.praiseworthiness;
                    qualified.agency = 'unknown';
                }
                else {
                    const behavior = repos.getRawMessage(vector.suppliedBehaviorRef);
                    const principal = behavior ? repos.db.get('SELECT principal_id FROM conversations WHERE id=?', behavior.conversationId)?.principal_id : null;
                    if (!behavior || behavior.role !== 'assistant' || behavior.deletedAtMs !== null || principal !== binding.principalId || behavior.occurredAtMs > message.occurredAtMs || behavior.seq >= message.seq)
                        throw Error('Invalid prior behavior reference');
                }
            }
            if ((qualified.personalAttention ?? 0) > .5 && !/(?:记得|记住|特意|还记|专门|remember|thoughtful)/i.test(message.content))
                delete qualified.personalAttention;
            if ((qualified.relationshipThreat ?? 0) > .5) {
                const relationship = repos.getSnapshot(binding.principalId)?.snapshot.relationship;
                if (!relationship || relationship.familiarity < .2 || !/(?:比你|取代|代替你|不想再.{0,8}(?:你|聊)|不再.{0,8}(?:你|聊)|更喜欢.{0,12}(?:陪|聊天)|只想.{0,10}陪)/.test(message.content))
                    delete qualified.relationshipThreat;
            }
            return qualified;
        });
        const sourceHash = contentHash(message.content);
        let saved = 0;
        for (let slot = 0; slot < valid.length; slot++) {
            const vector = valid[slot], id = `emotion:${message.id}:${slot}`;
            const existing = repos.db.get('SELECT vector_json,status,revision FROM emotion_appraisals WHERE id=?', id);
            if (withdrawnSources(repos, id, message.id).includes(sourceHash)) {
                if (existing?.status === 'active') {
                    archiveAppraisal(repos, id, existing);
                    repos.db.run("UPDATE emotion_appraisals SET status='retracted',revision=revision+1 WHERE id=?", id);
                }
                continue;
            }
            saved++;
            const json = JSON.stringify(vector);
            if (existing?.vector_json === json && existing.status === 'active')
                continue;
            if (existing)
                archiveAppraisal(repos, id, existing);
            repos.db.run(`INSERT INTO emotion_appraisals(id,principal_id,conversation_id,source_message_id,slot,vector_json,evidence_quote,event_time_ms,status,revision,producer)
        VALUES (?,?,?,?,?,?,?,?,'active',1,?) ON CONFLICT(id) DO UPDATE SET vector_json=excluded.vector_json,evidence_quote=excluded.evidence_quote,status='active',revision=emotion_appraisals.revision+1,producer=excluded.producer`, id, binding.principalId, message.conversationId, message.id, slot, json, vector.quote, message.occurredAtMs, producer);
        }
        // A corrected observation replaces its source's previous vector set, not an additional emotional hit.
        for (const row of repos.db.all("SELECT id,vector_json,status,revision FROM emotion_appraisals WHERE source_message_id=? AND slot>=? AND status='active'", message.id, valid.length)) {
            archiveAppraisal(repos, row.id, row);
        }
        repos.db.run("UPDATE emotion_appraisals SET status='retracted',revision=revision+1 WHERE source_message_id=? AND slot>=? AND status='active'", message.id, valid.length);
        return saved;
    });
}
const contentHash = (content) => createHash('sha256').update(content).digest('hex');
/** Stable source IDs survive owner pairing; hashes distinguish a genuinely edited source. */
function withdrawnSources(repos, id, sourceMessageId) {
    const value = repos.getSetting(`emotion.retracted:${id}`);
    if (value === undefined)
        return [];
    const marker = JSON.parse(value);
    if (marker.version !== 1 || marker.sourceMessageId !== sourceMessageId || !Array.isArray(marker.sourceHashes)
        || marker.sourceHashes.some(hash => typeof hash !== 'string' || !/^[a-f\d]{64}$/u.test(hash)))
        throw Error('Invalid emotion withdrawal marker');
    return marker.sourceHashes;
}
function archiveAppraisal(repos, id, row) {
    const fingerprint = createHash('sha256').update(JSON.stringify([row.vector_json, row.status])).digest('hex').slice(0, 16);
    repos.db.run('INSERT OR IGNORE INTO emotion_appraisal_revisions VALUES(?,?,?,?,?,?)', `${id}:r:${row.revision}:${fingerprint}`, id, row.revision, row.vector_json, row.status, Date.now());
}
export function retractEmotionAppraisal(repos, id, principalId) {
    return repos.db.transaction(() => {
        const row = repos.db.get('SELECT vector_json,status,revision,source_message_id FROM emotion_appraisals WHERE id=? AND principal_id=?', id, principalId);
        if (!row)
            return 0;
        const source = repos.getRawMessage(row.source_message_id);
        if (!source || source.deletedAtMs !== null)
            return 0;
        const hashes = withdrawnSources(repos, id, source.id), hash = contentHash(source.content);
        if (!hashes.includes(hash))
            repos.setSetting(`emotion.retracted:${id}`, JSON.stringify({ version: 1, sourceMessageId: source.id, sourceHashes: [...hashes, hash] }), Date.now());
        if (row.status !== 'active')
            return 0;
        archiveAppraisal(repos, id, row);
        return repos.db.run("UPDATE emotion_appraisals SET status='retracted',revision=revision+1 WHERE id=?", id).changes;
    });
}
export function priorExpectations(repos, principalId, beforeMs) {
    return repos.db.all("SELECT a.id,a.evidence_quote,a.vector_json FROM emotion_appraisals a JOIN raw_messages r ON r.id=a.source_message_id WHERE a.principal_id=? AND a.status='active' AND a.event_time_ms<? AND r.deleted_at_ms IS NULL AND json_extract(a.vector_json,'$.prospect')='pending' ORDER BY a.event_time_ms DESC LIMIT 8", principalId, beforeMs)
        .map(row => ({ id: row.id, quote: row.evidence_quote, desirability: JSON.parse(row.vector_json).desirability }));
}
export function priorBehaviors(repos, principalId, message) {
    return repos.db.all("SELECT r.id,r.content FROM raw_messages r JOIN conversations c ON c.id=r.conversation_id WHERE c.principal_id=? AND r.role='assistant' AND r.deleted_at_ms IS NULL AND r.occurred_at_ms<=? AND r.seq<? ORDER BY r.seq DESC LIMIT 6", principalId, message.occurredAtMs, message.seq).map(r => ({ id: r.id, text: r.content.slice(0, 300) }));
}
/** Source-derived state: deletion, imports and late appraisals all use this same replay. No read writes. */
export function continuousAffect(repos, config, principalId, nowMs) {
    if (!config.emotion.enabled)
        return null;
    const version = createHash('sha256').update(JSON.stringify(config.emotion)).digest('hex').slice(0, 16);
    const stamp = JSON.stringify(repos.db.get('SELECT revision,(SELECT data_version FROM pragma_data_version) AS external FROM continuous_meta WHERE singleton=1'));
    let owners = cache.get(repos);
    if (!owners) {
        owners = new Map();
        cache.set(repos, owners);
    }
    let history = owners.get(principalId);
    if (!history || history.stamp !== stamp) {
        const responses = repos.db.all("SELECT e.source_message_id AS id,e.event_time_ms FROM response_events e JOIN raw_messages r ON r.id=e.source_message_id JOIN conversations c ON c.id=r.conversation_id WHERE c.principal_id=? AND e.status='active' AND r.deleted_at_ms IS NULL ORDER BY e.event_time_ms,e.source_message_id", principalId).map(row => ({ id: row.id, at: row.event_time_ms }));
        const appraisals = repos.db.all("SELECT a.id,a.vector_json,a.event_time_ms,a.source_message_id FROM emotion_appraisals a JOIN raw_messages r ON r.id=a.source_message_id JOIN conversations c ON c.id=r.conversation_id WHERE c.principal_id=? AND a.principal_id=? AND a.status='active' AND r.deleted_at_ms IS NULL ORDER BY a.event_time_ms,a.source_message_id,a.slot", principalId, principalId)
            // Vectors are strictly validated on extraction/import; reads only decode the authoritative rows.
            .map(row => ({ id: row.id, vector: JSON.parse(row.vector_json), at: row.event_time_ms, sourceId: row.source_message_id }));
        history = { stamp, responses, appraisals };
        owners.set(principalId, history);
        if (owners.size > 1000)
            owners.delete(owners.keys().next().value);
    }
    const parameters = { contactTauHours: config.emotion.contactTauHours, responseRelief: config.emotion.responseRelief, cap: 1 };
    let drives = { atMs: history.responses[0]?.at ?? nowMs, contact: 0, exploration: 0, load: 0, responses: 0 };
    for (const response of history.responses)
        if (response.at <= nowMs)
            drives = respondDrive(drives, response.at, parameters);
    drives = projectDrives(drives, nowMs, parameters);
    const prior = new Map(), timed = [], emotions = new Map(), displays = new Set(), evidenceIds = new Set();
    for (const item of history.appraisals) {
        if (item.at > nowMs)
            continue;
        const result = classifyOcc(item.vector, item.vector.suppliedEvidenceRef ? prior.get(item.vector.suppliedEvidenceRef) : undefined);
        prior.set(item.id, item.vector);
        const decay = Math.pow(2, -Math.max(0, nowMs - item.at) / (config.emotion.componentHalfLifeMinutes * 60000));
        timed.push({ atMs: item.at, components: result.components, ...(item.vector.controllability !== undefined ? { control: item.vector.controllability } : {}) });
        for (const component of result.components)
            emotions.set(component.category, Math.min(1, (emotions.get(component.category) ?? 0) + component.intensity * decay));
        if (result.components.some(c => c.intensity * decay >= .12)) {
            for (const label of result.displays)
                displays.add(label);
            evidenceIds.add(item.sourceId);
        }
        if ((item.vector.appealingness ?? 0) > .3 && decay > .1)
            drives.exploration = Math.min(1, drives.exploration + .1 * decay);
    }
    return { version: 'continuous-v1', parameterVersion: version, drives, pad: projectPad(timed, nowMs, config.emotion.componentHalfLifeMinutes, config.emotion.moodHalfLifeMinutes), emotions: [...emotions].filter(([, v]) => v >= .05).map(([category, intensity]) => ({ category: category, intensity })).sort((a, b) => b.intensity - a.intensity).slice(0, 6), displays: [...displays].slice(0, 3), evidenceIds: [...evidenceIds].slice(-10), appraisalCount: history.appraisals.length };
}
//# sourceMappingURL=continuous-affect.js.map