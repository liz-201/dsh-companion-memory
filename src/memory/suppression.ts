import { createHash } from 'node:crypto'
export interface MemorySuppression { id: string; claimHash: string; objectHash: string | null; sourceIds: string[] }
export function memoryFingerprint(value: unknown): string {
  const text = typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : JSON.stringify(value)
  return createHash('sha256').update(text ?? 'null').digest('hex')
}
/** Match only the deleted fact and its old evidence; unrelated facts in the same source remain usable. */
export function suppressedBy(selectorJson: string, memory: { id: string; claim: string; object: unknown; sourceIds: string[] }): boolean {
  const selector = JSON.parse(selectorJson) as { memoryId?: string; suppressed?: MemorySuppression[] }
  if (selector.memoryId === memory.id) return true
  const claimHash = memoryFingerprint(memory.claim), objectHash = memory.object === null ? null : memoryFingerprint(memory.object)
  return (selector.suppressed ?? []).some(item => item.id === memory.id || memory.sourceIds.length > 0 && memory.sourceIds.every(id => item.sourceIds.includes(id)) && (item.claimHash === claimHash || objectHash !== null && item.objectHash === objectHash))
}
