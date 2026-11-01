import type { EmotionAppraisal } from './emotion-appraisal.js';
/** Host-side facts the model is not allowed to assert. */
export interface EroticEvidenceContext {
    /** The message is a real owner-typed input, not a bridge, another owner or an assistant turn. */
    isHuman: boolean;
    /** A private one-to-one conversation bound to the current companion and owner. */
    isPrivate: boolean;
    /** The module is opened on this machine. */
    enabled: boolean;
    /** Both the owner and the current character are declared adults on this machine. */
    adultsConfirmed: boolean;
}
export type EroticCue = {
    kind: 'interest';
    strength: number;
    quote: string;
} | {
    kind: 'stop';
    quote: string;
};
interface Clause {
    text: string;
    start: number;
    end: number;
}
/** Split on clause punctuation so every rule below can stay clause-local. */
declare function clauses(text: string): Clause[];
/**
 * Deterministic stop control. It never waits for the model, never requires the
 * module to be open and never needs an adult declaration: a boundary must land
 * even while the module is closed.
 */
export declare function isIntimacyStop(text: string, hadRecentSentIntent: boolean): boolean;
/**
 * Host qualification of one model-supplied cue. The model's `kind` is never trusted
 * on its own: the host re-derives the strength from its own clause analysis and
 * discards anything the source text does not support.
 */
export declare function qualifyEroticCue(vector: EmotionAppraisal, sourceText: string, context: EroticEvidenceContext): EroticCue | null;
/** Exposed for callers that need the same clause boundaries when building a quote. */
export { clauses as eroticClauses };
/** Recent-intent window for the soft stop path. */
export declare const INTIMACY_INTENT_WINDOW_MS: number;
