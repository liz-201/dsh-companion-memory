import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, lstatSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repositories } from './repositories.js';
import { backupNow, backupDirectory } from './backup.js';
import { rebuildAffect } from '../domain/affect-projector.js';
import { buildLexicalTerms } from '../memory/lexical-index.js';
import { revokeDerivedSources } from '../memory/habit-learning.js';
import { validatePersonality, TRAITS } from '../domain/personality-profile.js';
import { suppressedBy } from '../memory/suppression.js';
const TABLES = {
    companions: ['id'], principals: ['id'], conversations: ['id'], identity_links: ['namespace', 'external_key'], owner_channels: ['conversation_id'],
    raw_messages: ['id'], turns: ['id'], appraisals: ['id'], relationship_episodes: ['id'], affect_events: ['id'], affect_snapshots: ['principal_id'],
    memories: ['id'], memory_evidence: ['memory_id', 'message_id'], memory_edges: ['from_id', 'to_id', 'relation'], tasks: ['id'], outbox: ['id'],
    topic_checkpoints: ['id'], background_jobs: ['id'], deletion_tombstones: ['id'], audit_events: [], plugin_settings: ['key'],
    personality_profiles: ['revision_id'], personality_heads: ['companion_id', 'persona_id'], episodic_annotations: ['id'], expression_habits: ['id'], memory_lifecycle: ['memory_id'], proactive_feedback: ['id'], proactive_ownership: ['companion_id'],
};
const V2_TABLES = new Set(['personality_profiles', 'personality_heads', 'episodic_annotations', 'expression_habits', 'memory_lifecycle', 'proactive_feedback', 'proactive_ownership']);
const DERIVED = new Set(['affect_snapshots', 'relationship_episodes']);
const MAX_BYTES = 256 * 1024 * 1024;
const CHECKPOINT_LIMIT = 8;
const CHECKPOINT_BYTES = 1024 * 1024;
export class PortableImportError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PortableImportError';
    }
}
export function stableJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(stableJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}
function hash(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function keyFor(table, row) {
    return stableJson(TABLES[table].length ? TABLES[table].map(key => row[key]) : [row['kind'], row['entity_id'], row['created_at_ms'], row['payload_json']]);
}
function logicalRow(row) { const { seq: _seq, ...copy } = row; return copy; }
function inventory(tables) {
    return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, Object.fromEntries(rows.map(row => [keyFor(table, row), hash(row)]))]));
}
/** Bound lineage metadata; free pages are reused without vacuuming a live DB. */
export function prunePortableCheckpoints(db) {
    return db.transaction(() => {
        const rows = db.all('SELECT id, inventory_json FROM portable_checkpoints ORDER BY created_at_ms DESC, rowid DESC');
        const seen = new Set();
        let retained = 0, bytes = 0, removed = 0;
        for (const row of rows) {
            const size = Buffer.byteLength(row.inventory_json);
            if (!seen.has(row.inventory_json) && retained < CHECKPOINT_LIMIT && (retained === 0 || bytes + size <= CHECKPOINT_BYTES)) {
                seen.add(row.inventory_json);
                retained++;
                bytes += size;
            }
            else
                removed += db.run('DELETE FROM portable_checkpoints WHERE id = ?', row.id).changes;
        }
        return { removed, retained, bytes };
    });
}
function rememberCheckpoint(db, id, value, nowMs) {
    const serialized = stableJson(value);
    const existing = db.get('SELECT id FROM portable_checkpoints WHERE inventory_json = ? LIMIT 1', serialized);
    if (existing)
        db.run('UPDATE portable_checkpoints SET created_at_ms = MAX(created_at_ms, ?) WHERE id = ?', nowMs, existing.id);
    else
        db.run('INSERT INTO portable_checkpoints(id, inventory_json, created_at_ms) VALUES (?, ?, ?)', id, serialized, nowMs);
}
function transferableSetting(key) { return !key.startsWith('local.') && !key.startsWith('portable.') && !key.startsWith('review:') && !key.startsWith('consolidation.cursor:'); }
export function rememberImportReceipt(db, id, checksum, nowMs) {
    const prior = db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', id);
    if (prior)
        return prior.checksum === checksum ? 'present' : 'mismatch';
    db.run('INSERT OR IGNORE INTO portable_imports(package_id, checksum, imported_at_ms) VALUES (?, ?, ?)', id, checksum, nowMs);
    return 'inserted';
}
/** Refresh a verified, previously processed peer anchor before a cloud handshake.
 * Keeping the last snapshot of an offline peer gives it a common baseline even
 * after many exports on another device. Unprocessed files cannot claim lineage.
 */
export function refreshPortableBaseline(db, payload, checksum, nowMs = Date.now()) {
    const receipt = db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', payload.id);
    if (receipt?.checksum !== checksum)
        return false;
    db.transaction(() => {
        rememberCheckpoint(db, payload.id, inventory(payload.tables), nowMs);
        prunePortableCheckpoints(db);
    });
    return true;
}
export function snapshotForTransfer(db) {
    return Object.fromEntries(Object.keys(TABLES).map(table => [table, db.all(`SELECT * FROM ${table}`).map(logicalRow).filter(row => {
            if (table === 'plugin_settings')
                return transferableSetting(String(row['key']));
            if (table === 'outbox')
                return ['sent', 'unknown'].includes(String(row['status']));
            if (table === 'background_jobs')
                return row['kind'] === 'extract';
            return true;
        })]));
}
function pluginFiles(root) {
    const files = {};
    const visit = (path) => {
        const name = relative(root, path).split(sep).join('/');
        if (name === 'docs/_exchange' || ['docs/BRIDGE_PROTOCOL.md', 'docs/HANDOFF_CHATGPT_20261025.md'].includes(name))
            return;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
            throw new Error('Portable plugin must not contain symbolic links');
        if (stat.isDirectory()) {
            for (const name of readdirSync(path))
                visit(join(path, name));
            return;
        }
        files[relative(root, path).split(sep).join('/')] = readFileSync(path).toString('base64');
    };
    for (const entry of ['lib', 'migrations', 'prompts', 'integration', 'scripts', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE'])
        if (existsSync(join(root, entry)))
            visit(join(root, entry));
    return files;
}
export function exportPortable(db, config, file, options = {}) {
    const repos = new Repositories(db);
    const ownerId = repos.getSetting('owner.id');
    if (!ownerId)
        throw new Error('Owner identity is missing; start the plugin once before exporting');
    const id = randomUUID();
    const nowMs = options.nowMs ?? Date.now();
    const payload = db.transaction(() => ({
        format: 'dsh-companion-transfer', version: 2, formatVersion: 2, minReaderVersion: '0.3.0-dev.1', id, createdAtMs: nowMs, companionId: config.companion.id, ownerId,
        schema: db.all('SELECT version, checksum FROM schema_migrations ORDER BY version'),
        ancestors: db.all('SELECT id, inventory_json FROM portable_checkpoints ORDER BY created_at_ms DESC, rowid DESC LIMIT 8').reverse().map(row => ({ id: row.id, inventory: JSON.parse(row.inventory_json) })),
        tables: snapshotForTransfer(db), plugin: {},
    }));
    if (options.includePlugin !== false)
        payload.plugin = pluginFiles(options.pluginRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
    const bytes = Buffer.from(stableJson(payload));
    if (bytes.length > MAX_BYTES)
        throw new Error('Transfer package exceeds the 256 MiB uncompressed limit');
    const envelope = { format: 'dsh-companion-transfer', version: 2, sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') };
    const target = resolve(file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    db.transaction(() => {
        rememberCheckpoint(db, id, inventory(payload.tables), nowMs);
        // A compact receipt survives inventory pruning and prevents importing our
        // own exported files. The table is local metadata, outside transfer tables.
        rememberImportReceipt(db, id, envelope.sha256, nowMs);
        prunePortableCheckpoints(db);
    });
    return { file: target, id, messages: payload.tables['raw_messages'].length, memories: payload.tables['memories'].length };
}
export function readPortable(file) {
    if (statSync(file).size > MAX_BYTES * 2)
        throw new Error('Transfer file too large');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    if (envelope.format !== 'dsh-companion-transfer' || ![1, 2].includes(Number(envelope.version)) || typeof envelope.data !== 'string' || envelope.data.length > MAX_BYTES * 2)
        throw new Error('Unsupported transfer package');
    const bytes = gunzipSync(Buffer.from(envelope.data, 'base64'), { maxOutputLength: MAX_BYTES });
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== envelope.sha256)
        throw new Error('Transfer checksum mismatch; no data imported');
    const payload = JSON.parse(bytes.toString('utf8'));
    if (payload.format !== 'dsh-companion-transfer' || ![1, 2].includes(payload.version) || payload.version !== envelope.version || typeof payload.id !== 'string' || typeof payload.ownerId !== 'string' || !payload.tables || !Array.isArray(payload.ancestors))
        throw new Error('Invalid transfer payload');
    for (const table of Object.keys(payload.tables))
        if (!Object.hasOwn(TABLES, table) || !Array.isArray(payload.tables[table]))
            throw new Error(`Unsupported transfer table: ${table}`);
    for (const table of Object.keys(TABLES))
        if (!Array.isArray(payload.tables[table])) {
            if (payload.version === 1 && V2_TABLES.has(table))
                payload.tables[table] = [];
            else
                throw new Error(`Transfer table missing: ${table}`);
        }
    return { payload, checksum };
}
/** Extract only package-owned files into a new directory. Never touches a DSH profile or credentials. */
export function unpackPlugin(payload, directory) {
    const target = resolve(directory);
    if (existsSync(target))
        throw new Error('Plugin destination already exists; choose a new directory');
    const allowed = new Set(['lib', 'migrations', 'prompts', 'integration', 'scripts', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']);
    const entries = Object.entries(payload.plugin);
    for (const [name, data] of entries) {
        const parts = name.split('/');
        if (!allowed.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..' || /[:\\\0]/.test(part)) || typeof data !== 'string')
            throw new Error('Unsafe plugin path in transfer');
        if (!resolve(target, ...parts).startsWith(target + sep))
            throw new Error('Plugin extraction path escapes destination');
    }
    if (!payload.plugin['lib/index.js'] || !payload.plugin['package.json'])
        throw new Error('This transfer does not contain a plugin build');
    for (const [name, data] of entries) {
        const file = join(target, ...name.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' });
    }
}
function writeRow(db, table, row, existing) {
    const columns = Object.keys(row);
    if (!existing || !TABLES[table].length) {
        db.run(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]));
    }
    else {
        const keys = TABLES[table];
        const values = columns.filter(column => !keys.includes(column));
        if (values.length)
            db.run(`UPDATE ${table} SET ${values.map(column => `${column} = ?`).join(',')} WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`, ...values.map(column => row[column]), ...keys.map(key => row[key]));
    }
}
export function importPortable(db, config, payload, checksum, options = {}) {
    if (payload.format !== 'dsh-companion-transfer' || ![1, 2].includes(payload.version))
        throw new Error('Unsupported transfer package version');
    const nowMs = options.nowMs ?? Date.now();
    const repos = new Repositories(db);
    const report = { inserted: 0, updated: 0, deleted: 0, conflicts: 0, alreadyImported: false, backup: null, pausedTasks: 0, lineageMissing: false };
    const prior = db.get('SELECT checksum FROM portable_imports WHERE package_id = ?', payload.id);
    if (prior) {
        if (prior.checksum !== checksum)
            throw new Error('Transfer identity was reused with different content');
        return { ...report, alreadyImported: true };
    }
    if (payload.companionId !== config.companion.id)
        throw new Error(`Companion differs; configure companion.id=${payload.companionId} before import`);
    for (const source of payload.schema) {
        const local = db.get('SELECT checksum FROM schema_migrations WHERE version = ?', source.version);
        if (!local || local.checksum !== source.checksum)
            throw new Error('Database schema differs; install the included plugin version before importing');
    }
    const populated = Number(db.get('SELECT (SELECT COUNT(*) FROM raw_messages) + (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM affect_events) AS n')?.n ?? 0) > 0;
    if (populated && repos.getSetting('owner.id') !== payload.ownerId)
        throw new PortableImportError('owner-mismatch', 'Owner differs; refusing to combine two different owners');
    for (const [table, rows] of Object.entries(payload.tables)) {
        const columns = new Set(db.all(`PRAGMA table_info(${table})`).filter(column => column.name !== 'seq').map(column => column.name));
        const seen = new Set();
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row) || Object.entries(row).some(([column, value]) => !columns.has(column) || value !== null && typeof value !== 'string' && typeof value !== 'number'))
                throw new Error(`Invalid transfer row in ${table}`);
            const key = keyFor(table, row);
            if (V2_TABLES.has(table)) {
                for (const [column, value] of Object.entries(row))
                    if (column.endsWith('_json') && value !== null) {
                        if (typeof value !== 'string' || value.length > 65536)
                            throw new Error(`Transfer JSON exceeds limit: ${table}.${column}`);
                        JSON.parse(value);
                    }
                if (table === 'personality_profiles') {
                    const traits = JSON.parse(String(row['traits_json']));
                    if (Object.keys(traits).length !== TRAITS.length || TRAITS.some(key => traits[key] === undefined))
                        throw new Error('Invalid personality trait vector');
                    validatePersonality({ mix: {}, overrides: traits, variation: { enabled: false, maxDelta: .05, seed: null } });
                }
            }
            if (seen.has(key))
                throw new Error(`Duplicate transfer identity in ${table}`);
            seen.add(key);
        }
    }
    let base = {};
    for (const ancestor of payload.ancestors) {
        const known = db.get('SELECT inventory_json FROM portable_checkpoints WHERE id = ?', ancestor.id)
            ?? db.get('SELECT inventory_json FROM portable_checkpoints WHERE inventory_json = ? LIMIT 1', stableJson(ancestor.inventory));
        if (known) {
            if (hash(JSON.parse(known.inventory_json)) !== hash(ancestor.inventory))
                throw new Error('Transfer lineage mismatch');
            base = ancestor.inventory;
        }
    }
    // No shared ancestor: a three-way merge has no base to compare against. The import still runs
    // (inserts and tombstone replay stay correct), but every divergent existing row degrades to a
    // recorded conflict instead of an applied update. That is a diagnosis, never a silent success.
    // A first import into an empty database has nothing to protect, so it is not a degradation.
    const lineageMissing = populated && Object.keys(base).length === 0;
    report.lineageMissing = lineageMissing;
    if (db.file !== ':memory:') {
        // Repeating the same failed import against unchanged data must not create
        // another full backup on every launch. A changed local state still gets a
        // fresh pre-import backup, preserving exact rollback semantics.
        const key = `local.portable.backup:${hash([payload.id, checksum])}`;
        const state = hash(snapshotForTransfer(db));
        let previous = {};
        try {
            previous = JSON.parse(repos.getSetting(key) ?? '{}');
        }
        catch { }
        if (previous.state === state && previous.file && existsSync(previous.file))
            report.backup = previous.file;
        else {
            report.backup = backupNow(db, { directory: backupDirectory(db.file), keepDays: config.storage.backupRetentionDays, label: `${config.companion.id}-pre-import-${randomUUID()}` }, nowMs).file;
            repos.setSetting(key, JSON.stringify({ state, file: report.backup }), nowMs);
        }
    }
    const conflicts = (table, key, local, incoming, baseHash) => {
        const id = hash([payload.id, table, key]);
        db.run('INSERT OR IGNORE INTO portable_conflicts(id, package_id, table_name, row_key, local_json, incoming_json, base_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, payload.id, table, key, local ? stableJson(local) : null, incoming ? stableJson(incoming) : null, baseHash ?? null, nowMs);
        report.conflicts++;
    };
    db.transaction(() => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        // 审计行必须指向包内真实存在的 principals.id，不能用 ownerId（ownerId 只是 user_id，不是主键）。
        const ownerPrincipalId = (payload.tables['principals'] ?? []).find(row => row['bot_account_id'] === 'owner' && row['user_id'] === payload.ownerId)?.['id'];
        const local = snapshotForTransfer(db);
        const rebuild = new Set();
        const deletionRebuild = new Set();
        const deletes = [];
        db.run('UPDATE topic_checkpoints SET current_flag = 0');
        for (const [table, incomingRows] of Object.entries(payload.tables)) {
            const current = new Map(local[table].map(row => [keyFor(table, row), row]));
            const incoming = new Map(incomingRows.map(row => [keyFor(table, row), row]));
            for (const [key, raw] of incoming) {
                if (table === 'plugin_settings' && !transferableSetting(String(raw['key'])))
                    continue;
                const row = { ...raw };
                const existing = current.get(key);
                const baseHash = base[table]?.[key];
                const localHash = existing ? hash(existing) : undefined;
                const incomingHash = hash(raw);
                if (incomingHash === localHash)
                    continue;
                // A fresh device creates a placeholder before asynchronous cloud restore.
                // It is not an intentional ownership fork. Only the exact marked
                // bootstrap revision may yield; an explicit device take has another id.
                if (table === 'proactive_ownership' && !populated && existing &&
                    existing['revision_id'] === repos.getSetting('local.proactive.bootstrap-ownership')) {
                    writeRow(db, table, row, existing);
                    db.run("DELETE FROM plugin_settings WHERE key = 'local.proactive.bootstrap-ownership'");
                    report.updated++;
                    continue;
                }
                if (existing && ['personality_heads', 'proactive_ownership'].includes(table)) {
                    const parentField = table === 'personality_heads' ? db.get('SELECT parent_revision_ids_json FROM personality_profiles WHERE revision_id = ?', row['revision_id'])?.parent_revision_ids_json ?? payload.tables['personality_profiles']?.find(profile => profile['revision_id'] === row['revision_id'])?.['parent_revision_ids_json'] : row['parent_revision_ids_json'];
                    const parents = JSON.parse(String(parentField ?? '[]'));
                    const descendsFrom = (revision, ancestor) => {
                        const pending = [revision], seen = new Set();
                        while (pending.length && seen.size < 10000) {
                            const currentRevision = pending.pop();
                            if (currentRevision === ancestor)
                                return true;
                            if (seen.has(currentRevision))
                                continue;
                            seen.add(currentRevision);
                            const profile = db.get('SELECT parent_revision_ids_json FROM personality_profiles WHERE revision_id = ?', currentRevision);
                            const source = profile?.parent_revision_ids_json ?? payload.tables['personality_profiles']?.find(item => item['revision_id'] === currentRevision)?.['parent_revision_ids_json'];
                            if (source)
                                pending.push(...JSON.parse(String(source)));
                        }
                        return false;
                    };
                    const fastForward = table === 'personality_heads' ? descendsFrom(String(row['revision_id']), String(existing['revision_id'])) : parents.includes(String(existing['revision_id']));
                    if (table === 'personality_heads' && descendsFrom(String(existing['revision_id']), String(row['revision_id'])))
                        continue;
                    if (!fastForward) {
                        if (row['revision_id'] !== existing['revision_id']) {
                            const branches = [...new Set([String(existing['revision_id']), String(row['revision_id'])])].sort();
                            db.run(`UPDATE ${table} SET conflict_json = ? WHERE ${TABLES[table].map(key => `${key} = ?`).join(' AND ')}`, JSON.stringify(branches), ...TABLES[table].map(key => existing[key]));
                            conflicts(table, key, existing, raw, baseHash);
                        }
                        continue;
                    }
                    writeRow(db, table, { ...row, conflict_json: null }, existing);
                    report.updated++;
                    continue;
                }
                if (existing && incomingHash === baseHash)
                    continue;
                if (!existing && baseHash && populated)
                    continue; // Locally deleted: do not resurrect.
                if (table === 'affect_events' && row['principal_id'])
                    rebuild.add(String(row['principal_id']));
                if (existing && localHash !== baseHash) {
                    if (DERIVED.has(table)) {
                        rebuild.add(String(row['principal_id']));
                        continue;
                    }
                    if (table === 'raw_messages' && (existing['deleted_at_ms'] !== null || row['deleted_at_ms'] !== null)) {
                        row['deleted_at_ms'] = existing['deleted_at_ms'] ?? row['deleted_at_ms'];
                        if (row['deleted_at_ms'] !== null)
                            row['content'] = '';
                    }
                    else if (table === 'expression_habits' && (existing['status'] === 'revoked' || row['status'] === 'revoked'))
                        row['status'] = 'revoked';
                    else if (['outbox', 'background_jobs', 'audit_events'].includes(table))
                        continue;
                    else {
                        conflicts(table, key, existing, raw, baseHash);
                        continue;
                    }
                }
                if (table === 'outbox' && ['pending', 'sending', 'failed'].includes(String(row['status']))) {
                    row['status'] = 'cancelled';
                    row['last_error_code'] = 'portable-import-no-replay';
                }
                if (table === 'background_jobs' && ['pending', 'leased'].includes(String(row['status']))) {
                    // Observations are safe to resume: they only update memory and never send replies.
                    row['status'] = row['kind'] === 'extract' ? 'pending' : 'cancelled';
                    if (row['kind'] === 'extract') {
                        row['lease_until_ms'] = null;
                        row['available_at_ms'] = nowMs;
                    }
                }
                if (table === 'tasks' && row['status'] === 'confirmed' && !options.resumeReminders) {
                    row['status'] = 'proposed';
                    report.pausedTasks++;
                }
                if (table === 'topic_checkpoints')
                    row['current_flag'] = 0;
                writeRow(db, table, row, existing);
                if (existing)
                    report.updated++;
                else
                    report.inserted++;
            }
            for (const [key, row] of current)
                if (base[table]?.[key] && !incoming.has(key)) {
                    if (['outbox', 'background_jobs', 'personality_profiles', 'personality_heads', 'proactive_feedback', 'proactive_ownership'].includes(table))
                        continue;
                    if (hash(row) === base[table][key])
                        deletes.push({ table, row });
                    else if (!DERIVED.has(table))
                        conflicts(table, key, row, undefined, base[table][key]);
                }
        }
        for (const { table, row } of deletes.reverse()) {
            const keys = TABLES[table];
            if (!keys.length || table === 'plugin_settings' && !transferableSetting(String(row['key'])))
                continue;
            db.run(`DELETE FROM ${table} WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`, ...keys.map(key => row[key]));
            report.deleted++;
        }
        repos.setSetting('owner.id', payload.ownerId, nowMs);
        // SQLite row sequences are local to each database, never portable references.
        db.run("UPDATE conversations SET latest_inbound_seq = COALESCE((SELECT MAX(seq) FROM raw_messages WHERE conversation_id = conversations.id AND role = 'user'), 0)");
        if (!repos.getSetting('local.device-id'))
            repos.setSetting('local.device-id', randomUUID(), nowMs);
        // Tombstones override a stale copy's facts, including after a three-way branch merge.
        for (const tombstone of db.all('SELECT affected_ids_json, selector_json, principal_id FROM deletion_tombstones')) {
            const suppressedIds = db.all('SELECT id, claim, object_json FROM memories WHERE principal_id = ?', tombstone.principal_id).filter(memory => suppressedBy(tombstone.selector_json, { id: memory.id, claim: memory.claim, object: memory.object_json === null ? null : JSON.parse(memory.object_json), sourceIds: repos.memoryEvidence(memory.id).map(item => item.messageId) })).map(memory => memory.id);
            for (const id of new Set([...JSON.parse(tombstone.affected_ids_json), ...suppressedIds])) {
                revokeDerivedSources(repos, [id]);
                db.run('DELETE FROM memory_evidence WHERE memory_id = ? OR message_id = ?', id, id);
                db.run('DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?', id, id);
                db.run('DELETE FROM memories WHERE id = ?', id);
                db.run('UPDATE raw_messages SET content = ?, deleted_at_ms = COALESCE(deleted_at_ms, ?) WHERE id = ?', '', nowMs, id);
                for (const row of db.all("SELECT DISTINCT principal_id FROM affect_events WHERE status = 'active' AND json_extract(payload_json, '$.appraisal.sourceMessageId') = ?", id))
                    deletionRebuild.add(row.principal_id);
                db.run("UPDATE affect_events SET status = 'retracted' WHERE status = 'active' AND json_extract(payload_json, '$.appraisal.sourceMessageId') = ?", id);
            }
        }
        // Keep the imported snapshot exactly for a fresh/fast-forward restore. Rebuild only divergent projections.
        for (const principal of new Set([...(populated ? rebuild : []), ...deletionRebuild])) {
            const stored = repos.getSnapshot(principal);
            const snapshot = rebuildAffect(repos, config, principal, nowMs);
            repos.putSnapshot(snapshot, stored?.revision ?? 0);
        }
        db.run('UPDATE topic_checkpoints SET current_flag = 1 WHERE id IN (SELECT id FROM topic_checkpoints t WHERE id = (SELECT id FROM topic_checkpoints x WHERE x.conversation_id = t.conversation_id ORDER BY created_at_ms DESC, id DESC LIMIT 1))');
        if (db.capabilities().fts5) {
            db.run('DELETE FROM memory_fts');
            for (const memory of db.all('SELECT id, principal_id, claim, status FROM memories'))
                if (memory.status === 'active') {
                    const terms = buildLexicalTerms([memory.claim]);
                    db.run('INSERT INTO memory_fts(memory_id, principal_id, lexical_terms, aliases) VALUES (?, ?, ?, ?)', memory.id, memory.principal_id, terms, '');
                }
        }
        // 审计放在合并之后，才能记录真实的冲突条数；若随后回滚，审计与数据一起消失，不留半截证据。
        if (lineageMissing)
            repos.audit({ principalId: ownerPrincipalId === undefined ? null : String(ownerPrincipalId), kind: 'portable-import-no-lineage', entityId: payload.id, payload: { packageId: payload.id, version: payload.version, ancestors: payload.ancestors.length, conflicts: report.conflicts }, createdAtMs: nowMs });
        if (db.all('PRAGMA foreign_key_check').length)
            throw new Error('Transfer would break data references; import rolled back');
        for (const ancestor of payload.ancestors)
            rememberCheckpoint(db, ancestor.id, ancestor.inventory, nowMs - 1);
        const lineageTables = payload.version === 1 ? Object.fromEntries(Object.entries(payload.tables).filter(([table]) => !V2_TABLES.has(table))) : payload.tables;
        rememberCheckpoint(db, payload.id, inventory(lineageTables), nowMs);
        rememberImportReceipt(db, payload.id, checksum, nowMs);
        prunePortableCheckpoints(db);
    });
    return report;
}
//# sourceMappingURL=portable.js.map