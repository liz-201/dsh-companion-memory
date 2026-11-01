import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { buildLexicalTerms } from '../memory/lexical-index.js';
import { backupNow } from './backup.js';
import { Database, databaseFile, openDatabase } from './database.js';
import { replayTombstones } from './deletion.js';
import { migrate } from './migrations.js';
import { Repositories } from './repositories.js';
/** Offline only. Sanitize a staged copy before atomically replacing the closed target. */
export function restoreBackup(config, sourcePath, nowMs) {
    // Read before creating the pre-restore backup: the requested source could share its name.
    const bytes = readFileSync(sourcePath);
    const target = resolve(databaseFile(config.storage.directory, config.companion.id));
    const directory = dirname(target);
    const temporary = mkdtempSync(join(directory, '.companion-restore-'));
    const stagedFile = join(temporary, 'staged.sqlite3');
    let staged;
    const current = openDatabase(config.storage, false, config.companion.id);
    try {
        const currentRepos = new Repositories(current);
        const tombstones = currentRepos.listTombstones();
        writeFileSync(stagedFile, bytes);
        staged = new Database({ file: stagedFile, busyTimeoutMs: config.storage.busyTimeoutMs });
        const integrity = staged.get('PRAGMA integrity_check');
        if (integrity?.integrity_check !== 'ok')
            throw new Error('Backup integrity check failed');
        const fts5 = staged.capabilities().fts5;
        migrate(staged, { now: nowMs, fts5 });
        const repos = new Repositories(staged);
        const owner = currentRepos.getSetting('owner.id'), restoredOwner = repos.getSetting('owner.id');
        if (restoredOwner !== owner)
            throw new Error('Backup belongs to a different or unknown owner');
        if (!staged.get('SELECT id FROM companions WHERE id = ?', config.companion.id))
            throw new Error('Backup companion does not match');
        const db = staged;
        let replayed = 0;
        db.transaction(() => {
            for (const tombstone of tombstones) {
                const principalId = String(tombstone['principal_id']);
                const principal = current.get('SELECT * FROM principals WHERE id = ?', principalId);
                if (!principal || principal.companion_id !== config.companion.id)
                    throw new Error('Deletion principal does not match companion');
                const existing = db.get('SELECT * FROM principals WHERE id = ?', principalId);
                if (existing && (existing.companion_id !== principal.companion_id || existing.bot_account_id !== principal.bot_account_id || existing.user_id !== principal.user_id))
                    throw new Error('Deletion principal identity conflicts with backup');
                if (!existing)
                    repos.ensurePrincipal(principalId, principal.companion_id, principal.bot_account_id, principal.user_id, principal.created_at_ms);
                const prior = db.get('SELECT * FROM deletion_tombstones WHERE id = ?', tombstone['id']);
                if (prior && ['principal_id', 'selector_json', 'affected_ids_json', 'created_at_ms'].some(key => prior[key] !== tombstone[key]))
                    throw new Error('Deletion tombstone conflicts with backup');
                if (!prior)
                    repos.insertTombstone({ id: String(tombstone['id']), principalId,
                        selector: JSON.parse(String(tombstone['selector_json'])), affectedIds: JSON.parse(String(tombstone['affected_ids_json'])), createdAtMs: Number(tombstone['created_at_ms']) });
            }
            replayed = replayTombstones(db, repos, nowMs, config).replayed;
            if (fts5) {
                db.run('DELETE FROM memory_fts');
                for (const memory of db.all("SELECT id, principal_id, claim FROM memories WHERE status = 'active'")) {
                    db.run('INSERT INTO memory_fts(memory_id, principal_id, lexical_terms, aliases) VALUES (?, ?, ?, ?)', memory.id, memory.principal_id, buildLexicalTerms([memory.claim]), '');
                }
            }
            if (db.all('PRAGMA foreign_key_check').length)
                throw new Error('Backup contains broken references');
        });
        // Closing checkpoints WAL before the single-file replacement.
        staged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        staged.close();
        const record = backupNow(current, { directory: join(directory, 'backups'), keepDays: config.storage.backupRetentionDays,
            label: `${config.companion.id}-pre-restore` }, nowMs);
        if (current.get('PRAGMA wal_checkpoint(TRUNCATE)')?.busy !== 0)
            throw new Error('Target database is busy; restore requires offline access');
        current.close();
        renameSync(stagedFile, target);
        return { backupFile: record.file, replayed };
    }
    finally {
        staged?.close();
        current.close();
        const cleanup = resolve(temporary);
        if (!cleanup.startsWith(directory + sep) || !cleanup.slice(directory.length + 1).startsWith('.companion-restore-'))
            throw new Error('Unsafe restore cleanup');
        rmSync(cleanup, { recursive: true, force: true });
    }
}
//# sourceMappingURL=restore.js.map