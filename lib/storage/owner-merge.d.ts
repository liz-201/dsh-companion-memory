import type { Config } from '../config.js';
import type { Database } from './database.js';
import { type ImportReport, type PortablePayload } from './portable.js';
interface OwnerMergeCounts {
    messages: number;
    memories: number;
    affectEvents: number;
}
/** Only these deliberate user-facing errors may be shown by the local control panel. */
export declare class OwnerMergeInputError extends Error {
}
export interface OwnerMergeConflict {
    table: string;
    id: string;
    reason: string;
}
export interface OwnerMergePreview {
    version: 1;
    packageId: string;
    checksum: string;
    localOwnerId: string;
    remoteOwnerId: string;
    localFingerprint: string;
    payloadFingerprint: string;
    local: OwnerMergeCounts;
    remote: OwnerMergeCounts;
    blockingConflicts: OwnerMergeConflict[];
    report: ImportReport | null;
}
/** Preview the exact import inside a transaction that always rolls back, including its receipts and archives. */
export declare function previewOwnerMerge(db: Database, config: Config, payload: PortablePayload, checksum: string): OwnerMergePreview;
/** Apply a user-approved preview with one pre-adoption backup and one atomic transaction. */
export declare function confirmOwnerMerge(db: Database, config: Config, payload: PortablePayload, checksum: string, preview: OwnerMergePreview): ImportReport;
export {};
