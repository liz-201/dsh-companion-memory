import type { EroticInterestState } from '../domain/erotic-interest.js';
import type { TaskMode } from './task-mode.js';
/** Engineering initial values; these are output controls, not psychological scales. */
export declare const INTIMACY_THRESHOLDS: Readonly<{
    flutter: 0.25;
    yearning: 0.5;
    audit: 0.6;
    invitationTtlMs: number;
    expressionGapMs: number;
    epsilon: 1e-12;
}>;
export interface IntimacyInvitation {
    sourceId: string;
    atMs: number;
    /** Established by the host from the current, live owner source. Never model permission. */
    eligible: boolean;
}
export interface IntimacyIntent {
    kind: 'none' | 'flutter' | 'yearning';
    sourceId?: string;
    reasonCodes: string[];
}
export interface IntimacyPolicyInput {
    state: EroticInterestState | null;
    mode: TaskMode;
    isPrivate: boolean;
    invitation: IntimacyInvitation | null;
    nowMs: number;
    lastExpressionAtMs?: number;
    lastExpressionSourceId?: string;
    proactive?: boolean;
}
/** A read-only output decision. Successful delivery accounting belongs to the runtime. */
export declare function chooseIntimacyIntent(input: IntimacyPolicyInput): IntimacyIntent;
/** Final plan/render guard; source scope, timing and policy revisions are checked by the runtime. */
export declare function canExpressIntimacyIntent(intent: IntimacyIntent | undefined, state: EroticInterestState | null | undefined, mode: TaskMode): boolean;
export declare const INTIMACY_GUIDANCE: Readonly<{
    flutter: "可回应这次明确意愿，简短表达心动；不编现实接触，不把意愿当同意。";
    yearning: "可简短表达想更亲近的角色意愿，留出拒绝余地；不描写性行为或身体刺激，不声称真实生理需要。";
}>;
export declare function renderIntimacyDirection(intent: IntimacyIntent | undefined, state: EroticInterestState | null | undefined, mode: TaskMode): string;
