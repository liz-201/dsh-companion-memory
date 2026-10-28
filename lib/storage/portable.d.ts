import type { Config } from '../config.js';
import type { Database, Row } from './database.js';
type Snapshot = Record<string, Row[]>;
type Inventory = Record<string, Record<string, string>>;
interface Checkpoint {
    id: string;
    inventory: Inventory;
}
export interface PortablePayload {
    format: 'dsh-companion-transfer';
    version: 1 | 2 | 3 | 4;
    formatVersion?: 2 | 3 | 4;
    minReaderVersion?: string;
    id: string;
    createdAtMs: number;
    companionId: string;
    ownerId: string;
    schema: {
        version: number;
        checksum: string;
    }[];
    ancestors: Checkpoint[];
    tables: Snapshot;
    plugin: Record<string, string>;
}
export interface ImportReport {
    inserted: number;
    updated: number;
    deleted: number;
    conflicts: number;
    alreadyImported: boolean;
    backup: string | null;
    pausedTasks: number;
    lineageMissing: boolean;
}
export declare class PortableImportError extends Error {
    readonly code: 'owner-mismatch';
    constructor(code: 'owner-mismatch', message: string);
}
export declare function stableJson(value: unknown): string;
/** Bound lineage metadata; free pages are reused without vacuuming a live DB. */
export declare function prunePortableCheckpoints(db: Database): {
    removed: number;
    retained: number;
    bytes: number;
};
/**
 * Compact receipt: one row per package, survives inventory pruning.
 * It is what keeps an own export from being merged back as foreign data once its checkpoint is gone.
 */
export type ImportReceiptState = 'present' | 'inserted' | 'mismatch';
export declare function rememberImportReceipt(db: Database, id: string, checksum: string, nowMs: number): ImportReceiptState;
/** Refresh a verified, previously processed peer anchor before a cloud handshake.
 * Keeping the last snapshot of an offline peer gives it a common baseline even
 * after many exports on another device. Unprocessed files cannot claim lineage.
 */
export declare function refreshPortableBaseline(db: Database, payload: PortablePayload, checksum: string, nowMs?: number): boolean;
export declare function snapshotForTransfer(db: Database): Snapshot;
export declare function exportPortable(db: Database, config: Config, file: string, options?: {
    includePlugin?: boolean;
    pluginRoot?: string;
    nowMs?: number;
}): {
    file: string;
    id: string;
    messages: number;
    memories: number;
};
export declare function readPortable(file: string): {
    payload: PortablePayload;
    checksum: string;
};
/** Extract only package-owned files into a new directory. Never touches a DSH profile or credentials. */
export declare function unpackPlugin(payload: PortablePayload, directory: string): void;
export declare function importPortable(db: Database, config: Config, payload: PortablePayload, checksum: string, options?: {
    nowMs?: number;
    resumeReminders?: boolean;
    backup?: boolean;
    recordedTombstones?: boolean;
}): ImportReport;
export {};
