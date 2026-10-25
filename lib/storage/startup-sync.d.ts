import type { Config } from '../config.js';
import type { Database } from './database.js';
/** Exchange closed, checksummed files. Never share the live SQLite/WAL files. */
export declare class StartupSync {
    private readonly db;
    private readonly config;
    readonly directory: string;
    readonly reports: {
        file: string;
        conflicts?: number;
        lineageMissing?: boolean;
        error?: string;
    }[];
    lastExport: string | null;
    private fingerprint;
    private changeToken;
    constructor(db: Database, config: Config);
    importAtStartup(): void;
    publish(deviceId: string): void;
    private revision;
}
