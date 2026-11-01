/** Engineering initial values; these are output controls, not psychological scales. */
export const INTIMACY_THRESHOLDS = Object.freeze({
    flutter: .25,
    yearning: .50,
    audit: .60,
    invitationTtlMs: 10 * 60000,
    expressionGapMs: 20 * 60000,
    epsilon: 1e-12,
});
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const source = (value) => typeof value === 'string' && value.trim().length > 0
    && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
const reaches = (value, threshold) => value + INTIMACY_THRESHOLDS.epsilon >= threshold;
const available = (state) => !!state && state.blocked === false && state.blockReason === null
    && typeof state.value === 'number' && Number.isFinite(state.value) && state.value >= 0 && state.value <= 1;
/** A read-only output decision. Successful delivery accounting belongs to the runtime. */
export function chooseIntimacyIntent(input) {
    const none = (reason) => ({ kind: 'none', reasonCodes: [`intimacy:${reason}`] });
    if (input.mode !== 'chat')
        return none('suppressed-by-mode');
    if (input.isPrivate !== true)
        return none('private-owner-only');
    if (input.proactive !== undefined && input.proactive !== false)
        return none('no-proactive-expression');
    if (!timestamp(input.nowMs))
        return none('invalid-clock');
    if (!input.state)
        return none('no-state');
    if (input.state.blocked !== false || input.state.blockReason !== null)
        return none('blocked');
    if (input.state.value === null)
        return none('unknown');
    if (!available(input.state))
        return none('invalid-state');
    if (!timestamp(input.state.atMs) || input.state.atMs > input.nowMs)
        return none('future-state');
    const invitation = input.invitation;
    if (!invitation || invitation.eligible !== true || !source(invitation.sourceId))
        return none('no-current-invitation');
    if (!timestamp(invitation.atMs) || invitation.atMs > input.nowMs)
        return none('future-invitation');
    if (input.nowMs - invitation.atMs > INTIMACY_THRESHOLDS.invitationTtlMs)
        return none('expired-invitation');
    if (input.lastExpressionSourceId === invitation.sourceId)
        return none('invitation-already-used');
    if (input.lastExpressionAtMs !== undefined) {
        if (!timestamp(input.lastExpressionAtMs) || input.lastExpressionAtMs > input.nowMs)
            return none('invalid-delivery-clock');
        if (input.nowMs - input.lastExpressionAtMs < INTIMACY_THRESHOLDS.expressionGapMs)
            return none('expression-cooldown');
    }
    if (!reaches(input.state.value, INTIMACY_THRESHOLDS.flutter))
        return none('below-expression-threshold');
    const kind = reaches(input.state.value, INTIMACY_THRESHOLDS.yearning) ? 'yearning' : 'flutter';
    return { kind, sourceId: invitation.sourceId, reasonCodes: [`intimacy:${kind}`] };
}
/** Final plan/render guard; source scope, timing and policy revisions are checked by the runtime. */
export function canExpressIntimacyIntent(intent, state, mode) {
    if (mode !== 'chat' || !intent || intent.kind === 'none' || !source(intent.sourceId) || !available(state))
        return false;
    return intent.kind === 'yearning' ? reaches(state.value, INTIMACY_THRESHOLDS.yearning)
        : intent.kind === 'flutter' && reaches(state.value, INTIMACY_THRESHOLDS.flutter);
}
export const INTIMACY_GUIDANCE = Object.freeze({
    flutter: '可回应这次明确意愿，简短表达心动；不编现实接触，不把意愿当同意。',
    yearning: '可简短表达想更亲近的角色意愿，留出拒绝余地；不描写性行为或身体刺激，不声称真实生理需要。',
});
export function renderIntimacyDirection(intent, state, mode) {
    if (!canExpressIntimacyIntent(intent, state, mode) || !intent || intent.kind === 'none')
        return '';
    return INTIMACY_GUIDANCE[intent.kind];
}
//# sourceMappingURL=intimacy-policy.js.map