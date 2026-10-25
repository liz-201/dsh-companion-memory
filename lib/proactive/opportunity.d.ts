import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding, RawMessage } from '../domain/types.js';
export type OpportunityKind = 'follow_up' | 'interest_share' | 'positive_revisit' | 'shared_topic' | 'repair' | 'reminder' | 'computer_event';
export declare function opportunityScore(scores: Record<string, number>): number;
export declare function addOpportunity(repos: Repositories, input: {
    binding: IdentityBinding;
    kind: OpportunityKind;
    summary: string;
    sourceIds: string[];
    nowMs: number;
    notBeforeMs: number;
    expiresAtMs: number;
    scores?: Record<string, number>;
    topicRevision?: string;
}): string;
/** Deterministic explicit follow-up cues only; nothing is inferred from mere silence. */
export declare function observeOpportunity(repos: Repositories, binding: IdentityBinding, message: RawMessage): void;
