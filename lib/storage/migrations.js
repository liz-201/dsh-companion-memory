/**
 * 迁移执行器（任务书 §5.2 / §21.2）。
 *
 * 规则：
 * - 迁移脚本按版本号顺序执行，全部在**单个事务**里；中途失败整批回滚。
 * - schema_migrations 存 version + checksum，已应用的脚本内容变了就报校验错，
 *   不静默跳过（否则线上库结构与代码假设会悄悄分叉）。
 * - FTS5 是否可用在迁移时探测；不可用时跳过 002 并记录 degraded，检索层退化。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export function checksum(sql) {
    return createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 32);
}
/**
 * 从包内 migrations 目录读取。002 之前只有 001，`002_fts.sql` 在 FTS5 不可用时跳过。
 */
export function loadMigrations(directory) {
    const dir = directory ?? resolve(here, '..', '..', 'migrations');
    const files = readdirSync(dir)
        .filter((name) => /^\d{3}_.+\.sql$/.test(name))
        .sort();
    return files.map((name) => {
        const sql = readFileSync(join(dir, name), 'utf8');
        return {
            version: Number(name.slice(0, 3)),
            name,
            sql,
            checksum: checksum(sql),
        };
    });
}
export function ensureMigrationTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  )`);
}
export function appliedMigrations(db) {
    ensureMigrationTable(db);
    return db.all('SELECT version, checksum, applied_at_ms FROM schema_migrations ORDER BY version');
}
export function migrate(db, options) {
    ensureMigrationTable(db);
    const files = loadMigrations(options.directory);
    const applied = new Map();
    for (const record of appliedMigrations(db))
        applied.set(record.version, record);
    const result = { applied: [], skipped: [], ftsCreated: false, warnings: [] };
    db.transaction(() => {
        for (const file of files) {
            const existing = applied.get(file.version);
            if (existing !== undefined) {
                if (existing.checksum !== file.checksum) {
                    throw new Error(`迁移 ${file.name} 的校验和与库中记录不一致（库中 ${existing.checksum}，文件 ${file.checksum}）。` +
                        ' 已应用的迁移不允许原地修改，请追加新版本。');
                }
                result.skipped.push(file.version);
                continue;
            }
            if (file.name.includes('_fts') && !options.fts5) {
                result.warnings.push(`${file.name} 已跳过：当前驱动不支持 FTS5`);
                continue;
            }
            db.transaction(() => {
                db.exec(file.sql);
                db.run('INSERT INTO schema_migrations (version, checksum, applied_at_ms) VALUES (?, ?, ?)', file.version, file.checksum, options.now);
            });
            result.applied.push(file.version);
            if (file.name.includes('_fts'))
                result.ftsCreated = true;
        }
    });
    return result;
}
export function migrationStatus(db, directory) {
    const files = loadMigrations(directory);
    const records = appliedMigrations(db);
    const byVersion = new Map(records.map((record) => [record.version, record]));
    const pending = [];
    const checksumMismatch = [];
    let current = 0;
    for (const file of files) {
        const record = byVersion.get(file.version);
        if (record === undefined) {
            pending.push(file.version);
            continue;
        }
        current = Math.max(current, file.version);
        if (record.checksum !== file.checksum)
            checksumMismatch.push(file.name);
    }
    return { current, pending, checksumMismatch };
}
//# sourceMappingURL=migrations.js.map