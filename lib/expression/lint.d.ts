import type { ExpressionPlan } from '../domain/expression-plan.js';
export interface ExpressionIssue {
    code: string;
    severity: 'hard' | 'soft';
    start: number;
    end: number;
    reason: string;
    suggestedAction: 'keep' | 'lossless_edit' | 'regenerate' | 'block';
}
export declare function lintExpression(text: string, plan: ExpressionPlan, history?: readonly string[]): ExpressionIssue[];
