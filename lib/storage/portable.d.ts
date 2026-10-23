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
    version: 1;
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
}
export declare function stableJson(value: unknown): string;
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
}): ImportReport;
export {};
