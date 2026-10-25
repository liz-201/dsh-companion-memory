import { mkdirSync, readdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { exportPortable, importPortable, readPortable, rememberImportReceipt, stableJson, snapshotForTransfer } from './portable.js';
/** Exchange closed, checksummed files. Never share the live SQLite/WAL files. */
export class StartupSync {
    db;
    config;
    directory;
    reports = [];
    lastExport = null;
    fingerprint = '';
    changeToken = '';
    constructor(db, config) {
        this.db = db;
        this.config = config;
        this.directory = config.storage.transferDirectory || join(config.storage.directory, 'transfer');
    }
    importAtStartup() {
        const pending = [];
        let files;
        try {
            mkdirSync(this.directory, { recursive: true });
            files = readdirSync(this.directory);
        }
        catch (error) {
            this.reports.push({ file: this.directory, error: String(error) });
            return;
        }
        for (const file of files.filter(name => name.endsWith('.companion.json')).sort()) {
            try {
                const transfer = readPortable(join(this.directory, file));
                if (transfer.payload.companionId !== this.config.companion.id)
                    continue;
                const prior = this.db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', transfer.payload.id);
                if (prior) {
                    if (prior.checksum !== transfer.checksum)
                        throw new Error('Transfer identity was reused with different content');
                    continue;
                }
                // Legacy own export (written before receipts existed): a local checkpoint with this package
                // id is proof of lineage, so record the receipt instead of merging our own data back. The
                // receipt is what still blocks this file after pruning drops the checkpoint.
                if (this.db.get('SELECT id FROM portable_checkpoints WHERE id = ?', transfer.payload.id)) {
                    rememberImportReceipt(this.db, transfer.payload.id, transfer.checksum, Date.now());
                    continue;
                }
                pending.push(transfer);
            }
            catch (error) {
                this.reports.push({ file, error: String(error) });
            }
        }
        for (const { payload, checksum } of pending.sort((a, b) => a.payload.createdAtMs - b.payload.createdAtMs || a.payload.id.localeCompare(b.payload.id))) {
            try {
                const result = importPortable(this.db, this.config, payload, checksum);
                this.reports.push({ file: payload.id, conflicts: result.conflicts, lineageMissing: result.lineageMissing });
            }
            catch (error) {
                this.reports.push({ file: payload.id, error: String(error) });
            }
        }
    }
    publish(deviceId) {
        const changeToken = this.revision();
        if (changeToken === this.changeToken && this.lastExport && existsSync(this.lastExport))
            return;
        const fingerprint = createHash('sha256').update(stableJson(snapshotForTransfer(this.db))).digest('hex');
        if (fingerprint === this.fingerprint && this.lastExport && existsSync(this.lastExport)) {
            this.changeToken = changeToken;
            return;
        }
        mkdirSync(this.directory, { recursive: true });
        const companion = createHash('sha256').update(this.config.companion.id).digest('hex').slice(0, 12);
        const file = join(this.directory, `${companion}-${deviceId}.companion.json`);
        const temporary = join(this.directory, `${randomUUID()}.tmp`);
        try {
            exportPortable(this.db, this.config, temporary, { includePlugin: false });
            renameSync(temporary, file);
            this.lastExport = file;
            this.fingerprint = fingerprint;
            this.changeToken = this.revision();
        }
        finally {
            if (existsSync(temporary))
                unlinkSync(temporary);
        }
    }
    revision() {
        return `${this.db.get('SELECT total_changes() AS n')?.n}:${this.db.get('PRAGMA data_version')?.data_version}`;
    }
}
//# sourceMappingURL=startup-sync.js.map