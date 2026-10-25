/**
 * QQ 斜杠命令（任务书 §15.1）。
 *
 * 设计约束：
 *   - 这里的每条命令都必须能在**不经过模型**的情况下工作：用户敲 `/fish status`
 *     时不该先跑一轮生成。
 *   - 管理类命令（personality / proactive / reset / forget / correct）只认
 *     owner 私聊；群里任何人都能查 status/mood/memory，但看不到别人的记忆。
 *   - 破坏性命令要 `--confirm`。缺确认时**只提示一次**并带上完整可复制的命令，
 *     用户补上 `--confirm` 就执行——不允许反问两次（§15.1 明确禁止）。
 *   - 命令本身**不改关系**：管理命令一律只动配置/派生数据，不动 affect。
 */
import type { Config } from '../config.js';
import type { IdentityBinding } from '../domain/types.js';
import type { Database } from '../storage/database.js';
import type { Repositories } from '../storage/repositories.js';
import { backupNow } from '../storage/backup.js';
import type { Retriever } from '../memory/retriever.js';
import type { FactUpdater } from '../memory/fact-updater.js';
import type { Metrics } from '../runtime/metrics.js';
import type { CompatibilityReport } from '../adapters/compatibility.js';
import type { MemoryTransfer } from '../cloud/memory-transfer.js';
export type FishCommandKind = 'success' | 'error';
export interface FishCommandResult {
    kind: FishCommandKind;
    text: string;
    /** 命令是否写了持久状态：true 时上层应刷新本轮注入的上下文快照。 */
    mutated?: boolean;
}
export interface FishCommandInput {
    /** 去掉 `/fish` 前缀后的原文，例如 `memory 加班`。 */
    raw: string;
    binding: IdentityBinding;
    /** 是否 owner 私聊（管理命令的门槛）。 */
    isOwner: boolean;
    nowMs: number;
}
export interface SchedulerStatus {
    enabled: boolean;
    pending: number;
    lastScanAtMs: number | null;
    nextCheckAtMs: number | null;
    suppressedReason?: string | null;
}
export interface FishCommandDeps {
    transfer?: MemoryTransfer;
    manageUrl?: () => string;
    publishLocal?: () => string | null;
    review?: {
        begin: (fixture: string) => string;
        end: () => string;
    };
    config: Config;
    repos: Repositories;
    db: Database;
    retriever: Retriever;
    updater: FactUpdater;
    metrics: Metrics;
    /** 由 index.ts 注入的真实探针；离线 CLI 里为空。 */
    compatibility?: (() => CompatibilityReport | undefined) | undefined;
    scheduler?: {
        status: () => SchedulerStatus;
        setEnabled: (enabled: boolean) => void;
    };
    outboxStats?: (() => Record<string, number>) | undefined;
    backgroundStats?: (() => Record<string, number>) | undefined;
    log?: ((message: string) => void) | undefined;
}
export declare function handleFishCommand(input: FishCommandInput, deps: FishCommandDeps): FishCommandResult;
/** 命令名表：index.ts 注册 /fish 时用来判断「这条要不要拦」。 */
export declare const FISH_COMMANDS: readonly string[];
export declare function looksLikeFishCommand(text: string): boolean;
/** 从 `/fish xxx` 里剥出 `xxx`。 */
export declare function stripFishPrefix(text: string): string;
export { backupNow };
