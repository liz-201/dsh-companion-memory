export interface MemorySuppression {
    id: string;
    claimHash: string;
    objectHash: string | null;
    sourceIds: string[];
}
export declare function memoryFingerprint(value: unknown): string;
/** Match only the deleted fact and its old evidence; unrelated facts in the same source remain usable. */
export declare function suppressedBy(selectorJson: string, memory: {
    id: string;
    claim: string;
    object: unknown;
    sourceIds: string[];
}): boolean;
