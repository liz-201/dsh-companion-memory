import type { ExpressionPlan } from '../domain/expression-plan.js';
/**
 * Engineering initials, NOT measured psychological constants.
 * They exist so the rule is inspectable and adjustable, not because .6/.7 means anything empirical.
 */
export declare const REGULATION_THRESHOLDS: {
    /** Any impulse at or above this starts containing jokes and teasing. */
    readonly impulse: 0.6;
    /** Only anger-family impulse at or above this may justify a firm stance. */
    readonly firm: 0.7;
    /** Positive evidence at or above this is protected from arousal-driven suppression. */
    readonly joy: 0.6;
    /** Desire/passion at or above this triggers the no-inference guard. */
    readonly desire: 0.7;
};
export interface RelationshipHints {
    intimacy?: number;
    desire?: number;
    passion?: number;
}
/**
 * Expression-level regulation only: it may adjust stance, playfulness, meme permission and reasonCodes.
 * It never rewrites fact text, never touches requiredFacts/sourceIds/protectedSpans, never calls a model,
 * and never raises contact frequency or sentence targets.
 */
export declare function regulateExpression(plan: ExpressionPlan): ExpressionPlan;
