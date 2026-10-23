/**
 * 迁移执行器（任务书 §5.2 / §21.2）。
 *
 * 规则：
 * - 迁移脚本按版本号顺序执行，全部在**单个事务**里；中途失败整批回滚。
 * - schema_migrations 存 version + checksum，已应用的脚本内容变了就报校验错，
 *   不静默跳过（否则线上库结构与代码假设会悄悄分叉）。
 * - FTS5 是否可用在迁移时探测；不可用时跳过 002 并记录 degraded，检索层退化。
 */
import type { Database } from './database.js';
export interface MigrationFile {
    version: number;
    name: string;
    sql: string;
    checksum: string;
}
export interface MigrationRecord {
    version: number;
    checksum: string;
    applied_at_ms: number;
}
export interface MigrationResult {
    applied: number[];
    skipped: number[];
    ftsCreated: boolean;
    warnings: string[];
}
export declare function checksum(sql: string): string;
/**
 * 从包内 migrations 目录读取。002 之前只有 001，`002_fts.sql` 在 FTS5 不可用时跳过。
 */
export declare function loadMigrations(directory?: string): MigrationFile[];
export declare function ensureMigrationTable(db: Database): void;
export declare function appliedMigrations(db: Database): MigrationRecord[];
export interface MigrateOptions {
    now: number;
    /** 允许 FTS5 迁移；由调用方根据 capabilities().fts5 传入。 */
    fts5: boolean;
    directory?: string;
}
export declare function migrate(db: Database, options: MigrateOptions): MigrationResult;
export interface MigrationStatus {
    current: number;
    pending: number[];
    checksumMismatch: string[];
}
export declare function migrationStatus(db: Database, directory?: string): MigrationStatus;
