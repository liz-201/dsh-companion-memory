import type { Config } from '../config.js';
import type { Repositories } from './repositories.js';
import type { IdentityBinding, RawMessage } from '../domain/types.js';
import type { ContinuousAffectState } from '../domain/continuous-affect.js';
export type { ContinuousAffectState } from '../domain/continuous-affect.js';
/** Host binds all identities and quotes; model references are restricted to the supplied owner history. */
export declare function saveEmotionAppraisals(repos: Repositories, binding: IdentityBinding, message: RawMessage, candidates: unknown, producer?: string): number;
export declare function retractEmotionAppraisal(repos: Repositories, id: string, principalId: string): number;
export declare function priorExpectations(repos: Repositories, principalId: string, beforeMs: number): {
    id: string;
    quote: string;
    desirability?: number;
}[];
export declare function priorBehaviors(repos: Repositories, principalId: string, message: RawMessage): {
    id: string;
    text: string;
}[];
/** Source-derived state: deletion, imports and late appraisals all use this same replay. No read writes. */
export declare function continuousAffect(repos: Repositories, config: Config, principalId: string, nowMs: number): ContinuousAffectState | null;
