import type { Repositories } from '../storage/repositories.js';
import type { ValidatedAppraisal, IdentityBinding } from '../domain/types.js';
/** Store observed appraisals separately from later interpretations; never turn them into new evidence. */
export declare function annotateEpisode(repos: Repositories, principalId: string, appraisal: ValidatedAppraisal, nowMs: number): void;
export declare function archiveMemories(repos: Repositories, principalId: string, beforeMs: number): number;
export declare function repairContext(repos: Repositories, binding: IdentityBinding, memoryId: string): {
    messageId: string;
    quote: string;
}[];
