/**
 * Adult intimate-attraction axis. It is deliberately separate from `desire`
 * (owner-directed approach motivation) and from the legacy five slots: the two
 * must never be summed, because they answer different questions and share no
 * evidence source.
 */
export interface EroticInterestState {
    version: 'erotic-interest-v1';
    atMs: number;
    /** null = no qualified evidence yet; 0 = an effective trace was cleared or rejected. Never conflate the two. */
    value: number | null;
    evidenceIds: string[];
    blocked: boolean;
    blockReason: 'disabled' | 'adult-context-unknown' | 'owner-stop' | null;
    parameterVersion: 'erotic-engineering-v1';
}
export interface EroticInterestEvent {
    sourceId: string;
    atMs: number;
    strength: number;
    /** A higher revision replaces the lower one for the same source; it never adds to it. */
    revision?: number;
    status?: 'active' | 'retracted';
}
export interface EroticInterestPolicy {
    enabled: boolean;
    adultsConfirmed: boolean;
    stopped: boolean;
    /** 0 means no cutoff (pure-function tests). >0 accepts only events strictly after it. */
    epochMs: number;
}
export interface EroticInterestParameters {
    gain: number;
    halfLifeMinutes: number;
    epsilon: number;
    maxAgeMinutes: number;
}
/** Engineering priors only: no literature calibrates these numbers. */
export declare const EROTIC_INTEREST_DEFAULTS: EroticInterestParameters;
export declare const EROTIC_PARAMETER_VERSION = "erotic-engineering-v1";
/**
 * Pure projection over an event list. Reading it never writes back, never emits a
 * new event and never touches the relationship axes; repeated reads cannot raise
 * the value. Every rejection path returns an explicit state instead of a guess.
 */
export declare function projectEroticInterest(events: readonly EroticInterestEvent[], nowMs: number, policy: EroticInterestPolicy, parameters?: EroticInterestParameters): EroticInterestState;
