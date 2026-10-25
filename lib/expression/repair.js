import { lintExpression } from './lint.js';
/** These checks are deliberately conservative and do not claim semantic equivalence. */
export function preservedMeaning(before, after, plan) {
    const literals = (text) => JSON.stringify(text.match(/```[\s\S]*?```|`[^`]+`|https?:\/\/[^\s)]+|\d+(?:\.\d+)?|[“「][^”」]*[”」]/g) ?? []);
    const negations = (text) => (text.match(/不是|不要|不能|不必|不可以|没有|并非|不得/g) ?? []).length;
    return literals(before) === literals(after) && negations(before) === negations(after) && after.length >= before.length * .65 && plan.protectedSpans.every(span => after.includes(span.text)) && plan.requiredFacts.every(fact => after.includes(fact));
}
export async function guardExpression(text, plan, options = {}) {
    options.signal?.throwIfAborted();
    const issues = lintExpression(text, plan, options.history);
    if (!issues.length)
        return { text, status: 'pass', issues, repairCalls: 0, semanticChecks: { protected: 'pass' } };
    // Only remove a complete redundant satisfaction question. Never strip arbitrary clauses.
    const lossless = text.replace(/(?:这个回答你满意吗|这个回答满意吗|你满意吗)[？?]\s*$/u, '').trim();
    if (lossless && lossless !== text && !lintExpression(lossless, plan, options.history).length && plan.protectedSpans.every(span => lossless.includes(span.text)) && plan.requiredFacts.every(fact => lossless.includes(fact)))
        return { text: lossless, status: 'repaired', issues, repairCalls: 0, semanticChecks: { protected: 'pass' } };
    let repairCalls = 0;
    if (options.repair) {
        repairCalls = 1;
        try {
            const candidate = (await options.repair(text, issues)).trim();
            options.signal?.throwIfAborted();
            if (preservedMeaning(text, candidate, plan) && !lintExpression(candidate, plan, options.history).length)
                return { text: candidate, status: 'repaired', issues, repairCalls, semanticChecks: { protected: 'pass', fullMeaning: 'unknown' } };
        }
        catch (error) {
            options.signal?.throwIfAborted();
        }
    }
    const hard = issues.some(issue => issue.severity === 'hard');
    return { text: hard ? null : text, status: hard ? 'blocked' : 'degraded', issues, repairCalls, semanticChecks: { fullMeaning: 'unknown' } };
}
//# sourceMappingURL=repair.js.map