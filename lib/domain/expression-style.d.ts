import type { AffectSnapshot } from './types.js';
/** Expression is a projection, never a mutation of personality or relationship. */
export declare function expressionProfile(state: AffectSnapshot): {
    ease: number;
    openness: number;
    warmth: number;
    tone: string;
    playful: boolean;
    restrained: boolean;
};
/** Compact directions rather than canned dialogue or numeric status labels. */
export declare function renderExpressionStyle(state: AffectSnapshot): string;
