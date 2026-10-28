import type { Config } from '../config.js';
import type { Repositories } from './repositories.js';
import type { IdentityBinding, RawMessage } from '../domain/types.js';
import { type EmotionComponent } from '../domain/occ-classifier.js';
import { type DriveState } from '../domain/drive-projector.js';
import { projectPad } from '../domain/pad-projector.js';
export interface ContinuousAffectState {
    version: 'continuous-v1';
    parameterVersion: string;
    drives: DriveState;
    pad: ReturnType<typeof projectPad>;
    emotions: EmotionComponent[];
    displays: string[];
    evidenceIds: string[];
    appraisalCount: number;
}
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
