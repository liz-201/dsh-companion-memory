import { createHash, randomUUID } from 'node:crypto';
import { backupDirectory, backupNow } from './backup.js';
import { importPortable, snapshotForTransfer, stableJson } from './portable.js';
import { Repositories } from './repositories.js';
import { sharedOwnerPrincipal, unifyOwnerState } from './shared-owner.js';
/** Only these deliberate user-facing errors may be shown by the local control panel. */
export class OwnerMergeInputError extends Error {
}
const fingerprint = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
function assertIdle(db) {
    if (db.get("SELECT id FROM turns WHERE status = 'running' LIMIT 1")
        || db.get("SELECT id FROM background_jobs WHERE status = 'leased' AND lease_until_ms > ? LIMIT 1", Date.now())
        || db.get("SELECT id FROM outbox WHERE status = 'sending' LIMIT 1")) {
        throw new OwnerMergeInputError('请等待对话生成、后台整理和发送完成，再重新预览并合并。可在维护区暂时暂停后台整理。');
    }
}
function owners(rows, config, ownerId) {
    const canonical = sharedOwnerPrincipal(config, ownerId);
    return new Set(rows.filter(row => row['companion_id'] === config.companion.id && row['bot_account_id'] === 'owner'
        && (row['user_id'] === ownerId || row['id'] === canonical || String(row['id']).startsWith(canonical + ':persona:')))
        .map(row => String(row['id'])));
}
function counts(tables, principalIds) {
    const conversations = new Set((tables['conversations'] ?? []).filter(row => principalIds.has(String(row['principal_id']))).map(row => row['id']));
    return {
        messages: (tables['raw_messages'] ?? []).filter(row => conversations.has(row['conversation_id'])).length,
        memories: (tables['memories'] ?? []).filter(row => principalIds.has(String(row['principal_id']))).length,
        affectEvents: (tables['affect_events'] ?? []).filter(row => principalIds.has(String(row['principal_id']))).length,
    };
}
function validatePackage(config, payload, checksum) {
    if (!payload || payload.format !== 'dsh-companion-transfer' || ![1, 2, 3, 4].includes(payload.version)
        || typeof payload.id !== 'string' || !payload.id || typeof payload.ownerId !== 'string' || !payload.ownerId
        || !payload.tables || !Array.isArray(payload.schema) || typeof checksum !== 'string' || !checksum) {
        throw new OwnerMergeInputError('记忆文件信息无效，请重新选择文件并预览。');
    }
    if (payload.companionId !== config.companion.id)
        throw new OwnerMergeInputError('两份记忆使用了不同的伴侣标识，请先核对是否为同一个记忆体。');
}
function blockingConflicts(local, payload, principalIds, target) {
    const conflicts = [];
    const logical = (raw) => {
        const { seq: _seq, ...row } = raw;
        if (principalIds.has(String(row['principal_id'])))
            row['principal_id'] = target;
        return row;
    };
    for (const table of ['raw_messages', 'memories', 'affect_events', 'deletion_tombstones']) {
        const existing = new Map((local[table] ?? []).map(row => [row['id'], row]));
        for (const incoming of payload.tables[table] ?? []) {
            const previous = existing.get(incoming['id']);
            if (!previous)
                continue;
            const left = logical(previous), right = logical(incoming);
            if (table === 'raw_messages' && (left['deleted_at_ms'] != null || right['deleted_at_ms'] != null)) {
                // Deletion takes precedence over an old copy's clear text, not over a different message identity.
                left['content'] = right['content'] = '';
                left['deleted_at_ms'] = right['deleted_at_ms'] = null;
            }
            if (table === 'affect_events' && (left['status'] === 'retracted' || right['status'] === 'retracted'))
                left['status'] = right['status'] = 'retracted';
            if (table === 'deletion_tombstones') {
                for (const row of [left, right]) {
                    const selector = JSON.parse(String(row['selector_json']));
                    if (selector['kind'] === 'all')
                        delete selector['recordedOnly'];
                    row['selector_json'] = stableJson(selector);
                }
            }
            if (stableJson(left) !== stableJson(right))
                conflicts.push({ table, id: String(incoming['id']), reason: '同一 ID 对应不同内容，自动归并不能保证两边历史都保留。' });
        }
    }
    return conflicts;
}
function freezeAll(selector) {
    if (selector && typeof selector === 'object' && !Array.isArray(selector) && selector.kind === 'all') {
        return { ...selector, recordedOnly: true };
    }
    return selector;
}
function applyMerge(db, config, payload, checksum, localOwnerId, nowMs) {
    const repos = new Repositories(db);
    const target = sharedOwnerPrincipal(config, payload.ownerId);
    if (localOwnerId !== payload.ownerId) {
        const localIds = owners(db.all('SELECT * FROM principals'), config, localOwnerId);
        for (const tombstone of db.all('SELECT id, principal_id, selector_json FROM deletion_tombstones')) {
            if (!localIds.has(String(tombstone['principal_id'])))
                continue;
            const selector = JSON.parse(String(tombstone['selector_json']));
            if (selector.kind === 'all')
                db.run('UPDATE deletion_tombstones SET selector_json=? WHERE id=?', JSON.stringify(freezeAll(selector)), tombstone['id']);
        }
        repos.ensurePrincipal(target, config.companion.id, 'owner', payload.ownerId, nowMs);
        repos.setSetting('owner.id', payload.ownerId, nowMs);
        unifyOwnerState(repos, config, payload.ownerId, nowMs, { backup: false, sourceOwnerIds: [localOwnerId] });
    }
    // The import freezes incoming all-deletions only when writing rows, so lineage
    // and receipts remain bound to the original, unmodified package inventory.
    const report = importPortable(db, config, payload, checksum, { backup: false, recordedTombstones: true, nowMs });
    repos.setSetting('memory.owner-merge-version', '1', nowMs);
    if (db.all('PRAGMA foreign_key_check').length)
        throw new Error('归并将破坏数据引用，已全部回滚。');
    return report;
}
/** Preview the exact import inside a transaction that always rolls back, including its receipts and archives. */
export function previewOwnerMerge(db, config, payload, checksum) {
    validatePackage(config, payload, checksum);
    const localOwnerId = new Repositories(db).getSetting('owner.id');
    if (!localOwnerId)
        throw new OwnerMergeInputError('本机主人身份尚未初始化，请先启动插件。');
    const local = snapshotForTransfer(db);
    const localOwners = owners(local['principals'] ?? [], config, localOwnerId);
    const remoteOwners = owners(payload.tables['principals'] ?? [], config, payload.ownerId);
    const preview = {
        version: 1, packageId: payload.id, checksum, localOwnerId, remoteOwnerId: payload.ownerId,
        localFingerprint: fingerprint(local), payloadFingerprint: fingerprint(payload),
        local: counts(local, localOwners), remote: counts(payload.tables, remoteOwners),
        blockingConflicts: blockingConflicts(local, payload, new Set([...localOwners, ...remoteOwners]), sharedOwnerPrincipal(config, payload.ownerId)),
        report: null,
    };
    if (preview.blockingConflicts.length)
        return preview;
    const rollback = Symbol('owner-merge-preview');
    try {
        db.transaction(() => {
            preview.report = applyMerge(db, config, payload, checksum, localOwnerId, Date.now());
            throw rollback;
        });
    }
    catch (error) {
        if (error !== rollback)
            throw error;
    }
    return preview;
}
/** Apply a user-approved preview with one pre-adoption backup and one atomic transaction. */
export function confirmOwnerMerge(db, config, payload, checksum, preview) {
    validatePackage(config, payload, checksum);
    if (!preview || preview.version !== 1 || preview.packageId !== payload.id || preview.checksum !== checksum
        || preview.remoteOwnerId !== payload.ownerId || preview.payloadFingerprint !== fingerprint(payload)) {
        throw new OwnerMergeInputError('记忆文件或预览信息已变化，请重新预览后确认。');
    }
    const repos = new Repositories(db);
    const ownerId = repos.getSetting('owner.id');
    const receipt = db.get('SELECT checksum FROM portable_imports WHERE package_id=?', payload.id);
    if (receipt && receipt.checksum !== checksum)
        throw new OwnerMergeInputError('记忆包 ID 被不同内容重复使用，请重新导出并预览。');
    if (receipt && ownerId === payload.ownerId) {
        return { inserted: 0, updated: 0, deleted: 0, conflicts: 0, alreadyImported: true, backup: null, pausedTasks: 0, lineageMissing: false };
    }
    assertIdle(db);
    const current = snapshotForTransfer(db);
    if (ownerId !== preview.localOwnerId || preview.localFingerprint !== fingerprint(current)) {
        throw new OwnerMergeInputError('本机主人身份或记忆已变化，请重新预览后确认。');
    }
    const principalIds = new Set([
        ...owners(current['principals'] ?? [], config, preview.localOwnerId),
        ...owners(payload.tables['principals'] ?? [], config, payload.ownerId),
    ]);
    if (preview.blockingConflicts.length || !preview.report || blockingConflicts(current, payload, principalIds, sharedOwnerPrincipal(config, payload.ownerId)).length) {
        throw new OwnerMergeInputError('存在无法自动保留双方内容的 ID 冲突，请先处理冲突并重新预览。');
    }
    const nowMs = Date.now();
    const backup = db.file === ':memory:' ? null : backupNow(db, {
        directory: backupDirectory(db.file), keepDays: config.storage.backupRetentionDays,
        label: `${config.companion.id}-pre-owner-merge-${randomUUID()}`,
    }, nowMs).file;
    const result = db.transaction(() => {
        // The backup is outside the write transaction. Recheck after BEGIN IMMEDIATE
        // so another connection cannot change the approved input between this check
        // and adoption; a now-stale preview leaves the backup but changes no rows.
        if (repos.getSetting('owner.id') !== preview.localOwnerId || fingerprint(snapshotForTransfer(db)) !== preview.localFingerprint) {
            throw new OwnerMergeInputError('本机主人身份或记忆已变化，请重新预览后确认。');
        }
        assertIdle(db);
        return applyMerge(db, config, payload, checksum, preview.localOwnerId, nowMs);
    });
    return { ...result, backup };
}
//# sourceMappingURL=owner-merge.js.map