import type { Repositories } from './repositories.js';
import type { IdentityBinding, RawMessage } from '../domain/types.js';
import { type EroticInterestState } from '../domain/erotic-interest.js';
interface SavedPolicy {
    enabled: boolean;
    ownerAdultConfirmed: boolean;
    characterAdultConfirmed: boolean;
    characterContextId: string;
    acknowledgedStopIds: string[];
    resumeEpochMs: number;
    revision: number;
}
export interface LocalEroticPolicy extends SavedPolicy {
    adultsConfirmed: boolean;
    stopped: boolean;
    stopIds: string[];
}
export interface EroticPolicyInput {
    enabled: boolean;
    ownerAdultConfirmed: boolean;
    characterAdultConfirmed: boolean;
    characterContextId?: string;
    confirmedResume?: boolean;
    knownStopIds?: string[];
}
/** Age declarations stay bound to the exact host-selected character identity. */
export declare function isEroticCharacterConfirmed(repos: Repositories, principalId: string, conversationId: string): boolean;
/** Reads never manufacture a lease, permission, resume event or state increment. */
export declare function readEroticPolicy(repos: Repositories, principalId: string): LocalEroticPolicy;
/** Explicit, authenticated UI control only; imported packages never call this. */
export declare function setEroticPolicy(repos: Repositories, principalId: string, input: EroticPolicyInput, nowMs: number): LocalEroticPolicy;
/** Source IDs and source times make repeated observation on two devices identical. */
export declare function recordIntimacyStop(repos: Repositories, principalId: string, sourceMessageId: string | null, nowMs: number): LocalEroticPolicy;
export declare function hasRecentIntimacyIntent(repos: Repositories, principalId: string, nowMs: number): boolean;
export declare function readIntimacyExpression(repos: Repositories, principalId: string): {
    sourceId: string;
    atMs: number;
    policyRevision: number;
} | null;
export declare function recordIntimacyExpression(repos: Repositories, principalId: string, sourceId: string, nowMs: number): void;
export declare function observeIntimacyStop(repos: Repositories, binding: IdentityBinding, message: RawMessage, nowMs: number, recent?: boolean): boolean;
/** Replays original evidence. Does not accept an imported local permission. */
export declare function eroticAffect(repos: Repositories, principalId: string, nowMs: number): EroticInterestState;
export {};
