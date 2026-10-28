import type { ContinuousAffectState } from './continuous-affect.js';
import type { Mood } from './types.js';
/** Compatibility view from identified OCC components; PAD alone is not invertible. */
export declare function continuousMood(state: ContinuousAffectState | null, fallback: Mood): Mood;
/** Both real ingress paths use this view; factual-query scoring remains zero. */
export declare function retrievalArousal(state: ContinuousAffectState | null, fallback: Mood): number;
