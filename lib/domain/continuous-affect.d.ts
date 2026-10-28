import type { DriveState } from './drive-projector.js';
import type { EmotionComponent } from './occ-classifier.js';
import type { projectPad } from './pad-projector.js';
import type { RelationshipDynamicsState } from './relationship-dynamics.js';
/** Source-derived domain state; persistence and model transport are separate adapters. */
export interface ContinuousAffectState {
    version: 'continuous-v1';
    parameterVersion: string;
    drives: DriveState;
    pad: ReturnType<typeof projectPad>;
    emotions: EmotionComponent[];
    displays: string[];
    evidenceIds: string[];
    appraisalCount: number;
    /** Independent, source-replayed coordinates; never consent or a commitment. */
    relationship: RelationshipDynamicsState;
}
