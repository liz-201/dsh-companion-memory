import type { ExpressionPlan } from '../domain/expression-plan.js';
import { type ExpressionIssue } from './lint.js';
export interface GuardResult {
    text: string | null;
    status: 'pass' | 'repaired' | 'degraded' | 'blocked';
    issues: ExpressionIssue[];
    repairCalls: 0 | 1;
    semanticChecks: Record<string, 'pass' | 'fail' | 'unknown'>;
}
/** These checks are deliberately conservative and do not claim semantic equivalence. */
export declare function preservedMeaning(before: string, after: string, plan: ExpressionPlan): boolean;
export declare function guardExpression(text: string, plan: ExpressionPlan, options?: {
    history?: readonly string[];
    repair?: (text: string, issues: ExpressionIssue[]) => Promise<string>;
    signal?: AbortSignal;
}): Promise<GuardResult>;
