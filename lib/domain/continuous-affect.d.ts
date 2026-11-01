import type { DriveState } from './drive-projector.js';
import type { EmotionComponent } from './occ-classifier.js';
import type { projectPad } from './pad-projector.js';
import type { RelationshipDynamicsState } from './relationship-dynamics.js';
import type { EmotionExperience } from './emotion-experience.js';
import type { EmotionAppraisal } from './emotion-appraisal.js';
import type { EroticInterestState } from './erotic-interest.js';
export interface AffectContext {
    sourceId: string;
    atMs: number;
    concern: NonNullable<EmotionAppraisal['concern']>;
    topic: string;
    emotions: EmotionComponent[];
    experiences: EmotionExperience[];
    displays: string[];
}
/** Source-derived domain state; persistence and model transport are separate adapters. */
export interface ContinuousAffectState {
    version: 'continuous-v1';
    parameterVersion: string;
    drives: DriveState;
    pad: ReturnType<typeof projectPad>;
    emotions: EmotionComponent[];
    experiences?: EmotionExperience[];
    contexts?: AffectContext[];
    ownerDirectedAnger?: number;
    displays: string[];
    evidenceIds: string[];
    appraisalCount: number;
    /** Independent, source-replayed coordinates; never consent or a commitment. */
    relationship: RelationshipDynamicsState;
    eroticInterest?: EroticInterestState;
}
