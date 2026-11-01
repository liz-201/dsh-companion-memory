import type { ExpressionPlan } from '../domain/expression-plan.js';
export declare function hasIntimacyVoice(text: string): boolean;
/** A failed gate blocks the draft; it never deletes arbitrary factual clauses. */
export declare function intimacyOutputIssue(text: string, plan: ExpressionPlan, stale: boolean): string | null;
