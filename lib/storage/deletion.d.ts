/**
 * 删除与 tombstone（任务书 §10.6 / §15.3 / §21.2）。
 *
 * 用户说「忘掉这件事」时，要清掉的是一整条派生链：
 *   原文 → 派生记忆 → FTS → embedding → 检查点引用 → 未结任务 → 情感影响
 *
 * 情感影响不能直接改数值（那会让历史与状态不一致），而是把相关 affect event
 * 标为 retracted，再由投影重算。这里记录 tombstone，恢复旧备份后重放它。
 */
import type { Database } from './database.js';
import type { Repositories } from './repositories.js';
import type { Config } from '../config.js';
export type DeleteSelector = {
    kind: 'memory';
    memoryId: string;
} | {
    kind: 'message';
    messageId: string;
} | {
    kind: 'episode';
    episodeId: string;
} | {
    kind: 'task';
    taskId: string;
} | {
    kind: 'all';
};
export interface DeleteResult {
    tombstoneId: string;
    removedMemories: string[];
    removedMessages: string[];
    retractedAffectEvents: number;
    clearedCheckpoints: number;
    cancelledTasks: number;
    /** 说明哪些副本不在本次删除范围内（备份窗口）。 */
    notes: string[];
}
export declare function deleteScope(db: Database, repos: Repositories, principalId: string, selector: DeleteSelector, nowMs: number, backupKeepDays: number, config?: Config): DeleteResult;
/** 恢复备份后调用：把 tombstone 里记录过的行再次清掉。 */
export declare function replayTombstones(db: Database, repos: Repositories, nowMs: number, config?: Config): {
    replayed: number;
    removedMemories: number;
};
