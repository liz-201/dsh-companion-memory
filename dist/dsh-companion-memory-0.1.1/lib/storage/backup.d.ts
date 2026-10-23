/**
 * 备份（任务书 §21.2）。
 *
 * 用 `VACUUM INTO` 生成一致性快照：它在事务里读，不会拿到半写状态，也不需要
 * 停写。文件名带本地日期，保留 N 天；超过保留期的自动清理。
 *
 * 注意：备份是「恢复用」不是「删除用」。恢复旧备份后必须先重放
 * deletion_tombstones（deletion.ts 的 replayTombstones），否则会复活已删除数据。
 */
import type { Database } from './database.js';
export interface BackupOptions {
    directory: string;
    keepDays: number;
    /** 文件名前缀，一般是 companionId。 */
    label: string;
}
export interface BackupRecord {
    file: string;
    bytes: number;
    createdAtMs: number;
}
export declare function backupDirectory(dbFile: string): string;
/**
 * 生成一次备份。同一天重复调用会覆盖当天文件（当天的备份是最新的更好）。
 */
export declare function backupNow(db: Database, options: BackupOptions, nowMs: number): BackupRecord;
export declare function listBackups(directory: string): BackupRecord[];
/** 删除超过 keepDays 的备份，返回被删除的文件。当天永远保留。 */
export declare function pruneBackups(directory: string, keepDays: number, nowMs: number): string[];
export interface BackupSummary {
    latest?: BackupRecord | undefined;
    total: number;
    bytes: number;
    directory: string;
}
export declare function backupSummary(directory: string): BackupSummary;
