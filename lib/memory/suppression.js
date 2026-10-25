import { createHash } from 'node:crypto';
export function memoryFingerprint(value) {
    const text = typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : JSON.stringify(value);
    return createHash('sha256').update(text ?? 'null').digest('hex');
}
/** Match only the deleted fact and its old evidence; unrelated facts in the same source remain usable. */
export function suppressedBy(selectorJson, memory) {
    const selector = JSON.parse(selectorJson);
    if (selector.memoryId === memory.id)
        return true;
    const claimHash = memoryFingerprint(memory.claim), objectHash = memory.object === null ? null : memoryFingerprint(memory.object);
    return (selector.suppressed ?? []).some(item => item.id === memory.id || memory.sourceIds.length > 0 && memory.sourceIds.every(id => item.sourceIds.includes(id)) && (item.claimHash === claimHash || objectHash !== null && item.objectHash === objectHash));
}
//# sourceMappingURL=suppression.js.map