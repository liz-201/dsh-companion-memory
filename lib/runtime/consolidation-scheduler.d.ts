import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { BackgroundQueue } from './background-queue.js';
/** One upgrade pass; terminal protocol failures are not reset every restart. */
export declare function recoverConsolidationJobs(repos: Repositories, nowMs: number): number;
/** Count persisted user messages, independent of who generated the visible reply. */
export declare function scheduleConsolidation(repos: Repositories, config: Config, background: BackgroundQueue, conversationId: string, principalId: string, nowMs: number, options?: {
    throughSeq?: number;
    excludeJobId?: string;
}): boolean;
