const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === 'string' && value.trim() ? value : null;
/** Read complete JSON values, respecting quoted braces and escaped quotes. */
export function parseConsolidationOutput(output) {
    const candidates = [output.trim(), ...Array.from(output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), match => match[1].trim())];
    const normalize = (value) => Array.isArray(value) ? { changes: value } : Array.isArray(record(value)['changes']) ? record(value) : null;
    for (const candidate of candidates) {
        try {
            const parsed = normalize(JSON.parse(candidate));
            if (parsed)
                return parsed;
        }
        catch { }
    }
    for (let start = 0; start < output.length; start++) {
        if (!['{', '['].includes(output[start]))
            continue;
        const stack = [];
        let quoted = false, escaped = false;
        for (let end = start; end < output.length; end++) {
            const char = output[end];
            if (quoted) {
                if (escaped)
                    escaped = false;
                else if (char === '\\')
                    escaped = true;
                else if (char === '"')
                    quoted = false;
                continue;
            }
            if (char === '"') {
                quoted = true;
                continue;
            }
            if (char === '{' || char === '[')
                stack.push(char);
            else if (char === '}' || char === ']') {
                if (stack.pop() !== (char === '}' ? '{' : '['))
                    break;
                if (!stack.length) {
                    try {
                        const parsed = normalize(JSON.parse(output.slice(start, end + 1)));
                        if (parsed)
                            return parsed;
                    }
                    catch { }
                    start = end;
                    break;
                }
            }
        }
    }
    return null;
}
function changesOf(values) {
    return values.slice(0, 20).flatMap(value => {
        const row = record(value), kind = text(row['kind']), claim = text(row['claim']), quote = text(row['quote']);
        const ids = row['sourceMessageIds'];
        if (!kind || !['episode', 'fact', 'preference', 'interaction_rule', 'hypothesis'].includes(kind) || !claim || !quote || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string'))
            return [];
        const relation = row['relation'];
        return [{ kind: kind, subject: text(row['subject']), predicate: text(row['predicate']), object: row['object'] ?? null,
                claim, quote, sourceMessageIds: ids, confidence: typeof row['confidence'] === 'number' ? row['confidence'] : .6,
                salience: typeof row['salience'] === 'number' ? row['salience'] : .5, eventAtMs: typeof row['eventAtMs'] === 'number' ? row['eventAtMs'] : null,
                ...(typeof relation === 'string' && ['updates', 'contradicts', 'supports', 'derived_from'].includes(relation) ? { relation: relation } : {}) }];
    });
}
export async function requestConsolidationPlan(batch, afterSeq, generate) {
    const problems = [];
    let parsed = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const output = await generate(attempt === 1 ? '' : `上次整理结果不符合契约（${problems.join(',')}）。只输出一个 JSON 对象，格式为 {"changes":[],"cursor":${batch.cursor},"summary":null}；每批最多20条，有依据的变更才写入 changes，并保留本批来源 ID 与原话。示例只表示格式；cursor 应是实际完整处理到的 seq，未覆盖的尾部留给下批，不要照抄示例数字。`);
        if (output.length > 131072) {
            problems.push('output-too-large');
            continue;
        }
        parsed = parseConsolidationOutput(output);
        if (!parsed) {
            problems.push('missing-changes');
            continue;
        }
        const cursor = parsed['cursor'];
        const invalidCursor = !batch.fragment && cursor !== undefined && cursor !== null && (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor <= afterSeq || cursor > batch.cursor);
        if (invalidCursor) {
            problems.push('cursor-outside-batch');
            if (attempt === 1)
                continue;
        }
        const values = parsed['changes'];
        let changes = changesOf(values);
        const invalidShape = changes.length !== Math.min(values.length, 20);
        if (invalidShape) {
            problems.push('invalid-change-shape');
            if (attempt === 1)
                continue;
        }
        const truncated = values.length > 20;
        if (truncated)
            problems.push('changes-truncated');
        let nextCursor = batch.fragment || invalidCursor ? batch.cursor : typeof cursor === 'number' ? cursor : batch.cursor;
        if (!batch.fragment && changes.length && (invalidCursor || invalidShape || truncated)) {
            const known = new Map(batch.messages.map(message => [message.id, message.seq]));
            const covered = changes.flatMap(change => change.sourceMessageIds.map(id => known.get(id))).filter((seq) => seq !== undefined && seq > afterSeq);
            if (covered.length)
                nextCursor = Math.min(nextCursor, Math.max(...covered));
        }
        let summary = text(parsed['summary']);
        if (!batch.fragment) {
            const known = new Map(batch.messages.map(message => [message.id, message.seq]));
            const inRange = changes.filter(change => change.sourceMessageIds.every(id => (known.get(id) ?? -1) <= nextCursor));
            if (inRange.length !== changes.length) {
                problems.push('changes-beyond-cursor');
                if (attempt === 1)
                    continue;
                // Preserve the declared completed prefix. Moving the cursor forward to
                // a later citation would skip intervening messages not yet processed.
                changes = inRange;
                summary = null;
            }
        }
        return { plan: { changes, cursor: nextCursor, summary }, attempts: attempt, degraded: problems.length > 0, problems };
    }
    // This is a diagnosed compression failure, never fabricated memory. Originals
    // and independently extracted facts remain intact and available for review.
    return { plan: { changes: [], cursor: batch.cursor, summary: null }, attempts: 2, degraded: true, problems };
}
//# sourceMappingURL=consolidation-output.js.map