import type { Config } from '../config.js';
/** Offline only. Sanitize a staged copy before atomically replacing the closed target. */
export declare function restoreBackup(config: Config, sourcePath: string, nowMs: number): {
    backupFile: string;
    replayed: number;
};
