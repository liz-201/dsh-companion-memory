/**
 * SQLite 连接与能力探测（任务书 §5.1 / §5.2 / §3.3）。
 *
 * 驱动选择：宿主 Node 24 自带 `node:sqlite`（实测 SQLite 3.53.4），不需要
 * 编译 native 模块，也不会有 ABI 不匹配。使用同步驱动，因此：
 *   - 所有写操作走短事务 + 有序执行（repositories 层保证顺序）；
 *   - 事件循环影响由 scripts/benchmark.mjs 实测记录，不用 Promise.race 假装中断。
 *
 * 这个文件只负责「怎么连、连上有什么能力」，不含任何业务 SQL。
 */
import { DatabaseSync } from 'node:sqlite';
import type { StorageConfig } from '../config.js';
export interface DatabaseOptions {
    file: string;
    busyTimeoutMs: number;
    /** true 时用 `:memory:`，仅供测试。 */
    memory?: boolean;
}
export interface SqliteCapabilities {
    sqliteVersion: string;
    fts5: boolean;
    json1: boolean;
    wal: boolean;
    driver: 'node:sqlite';
    driverVersion: string;
}
export interface SqlValue {
    readonly [key: string]: unknown;
}
export type Row = Record<string, unknown>;
/**
 * 薄封装：只暴露 exec/prepare/transaction，其他一律由 repositories 负责，
 * 避免上层随手拼 SQL。
 */
export declare class Database {
    readonly raw: DatabaseSync;
    readonly file: string;
    private closed;
    private depth;
    constructor(options: DatabaseOptions);
    get isOpen(): boolean;
    exec(sql: string): void;
    prepare(sql: string): import("node:sqlite").StatementSync;
    /** 单行查询，没有结果返回 undefined。 */
    get<T = Row>(sql: string, ...params: unknown[]): T | undefined;
    all<T = Row>(sql: string, ...params: unknown[]): T[];
    run(sql: string, ...params: unknown[]): {
        changes: number;
        lastInsertRowid: number;
    };
    /**
     * 同步事务。嵌套调用复用外层事务（savepoint 语义由外层 BEGIN 承担），
     * 抛错一律 ROLLBACK 并原样抛出——不允许「吞掉异常当作成功」。
     */
    transaction<T>(work: () => T): T;
    capabilities(): SqliteCapabilities;
    close(): void;
    private assertOpen;
}
/**
 * 打开伴生库。
 *
 * `companionId` 是**必填**的：早期版本把 `storage.directory` 直接当库文件打开，
 * 结果在目录已存在时得到 `unable to open database file`（SQLite 打不开目录），
 * 在目录不存在时更糟——它悄悄建了一个名叫目录名的文件。所以这里强制走
 * `databaseFile()` 拼出 `<directory>/<companionId>.sqlite3`。
 */
export declare function openDatabase(storage: StorageConfig, memory: boolean, companionId: string): Database;
/** 数据库文件路径：<storage.directory>/<companionId>.sqlite3 */
export declare function databaseFile(storageDirectory: string, companionId: string): string;
export declare function databaseExists(file: string): boolean;
