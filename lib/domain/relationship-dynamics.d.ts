/**
 * Source-derived relationship axes. These are engineering coordinates, not a
 * psychological scale, an inference of consent, or proof of a relationship.
 */
export interface RelationshipDynamicsEvent {
    sourceId: string;
    /** Original source time, in integer Unix milliseconds. */
    atMs: number;
    /** Evidence-bound approach/separation signal, independent of object liking. */
    intimacyDelta?: number;
    /** Explicit approach/withdrawal motivation; absence is unknown, not inferred. */
    pull?: number;
    /** A correction replaces this source's older revision instead of adding it. */
    revision?: number;
    status?: 'active' | 'retracted';
}
export interface RelationshipDynamicsParameters {
    initialIntimacy: number;
    intimacyGain: number;
    desireGain: number;
    desireHalfLifeMinutes: number;
    passionHalfLifeMinutes: number;
    passionIntimacyGain: number;
    passionPullGain: number;
    withdrawalDesireLoss: number;
    withdrawalPassionLoss: number;
    separationPassionLoss: number;
}
export interface RelationshipDynamicsState {
    atMs: number;
    intimacy: number;
    desire: number;
    passion: number;
    /** Chronological, unique active sources containing an explicit nonzero signal. */
    evidenceIds: string[];
    sourceCount: number;
    parameterVersion: 'relationship-engineering-v1';
}
/** All values are product initial values awaiting calibration, not study norms. */
export declare const RELATIONSHIP_DYNAMICS_DEFAULTS: Readonly<RelationshipDynamicsParameters>;
/**
 * Recompute from authoritative sources; never persist a read projection as a
 * new input event. Removing a source or supplying a retracted higher revision
 * removes its effects on the next replay. No idle term changes intimacy.
 */
export declare function projectRelationshipDynamics(events: readonly RelationshipDynamicsEvent[], nowMs: number, overrides?: Partial<RelationshipDynamicsParameters>): RelationshipDynamicsState;
