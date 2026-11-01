/** Engineering priors only: no literature calibrates these numbers. */
export const EROTIC_INTEREST_DEFAULTS = { gain: .30, halfLifeMinutes: 720, epsilon: .001, maxAgeMinutes: 10080 };
export const EROTIC_PARAMETER_VERSION = 'erotic-engineering-v1';
const MINUTE = 60000;
const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const revisionOf = (event) => Number.isFinite(event.revision) ? event.revision : 0;
/** A parameter outside its legal range is a programming error, never a value to substitute. */
function checkedParameters(parameters) {
    const require = (label, value, low, high, exclusiveLow = false) => {
        if (!Number.isFinite(value) || (exclusiveLow ? value <= low : value < low) || value > high) {
            throw Error(`invalid erotic interest parameter: ${label}`);
        }
    };
    require('gain', parameters.gain, 0, 1);
    require('halfLifeMinutes', parameters.halfLifeMinutes, 0, Number.MAX_SAFE_INTEGER, true);
    require('epsilon', parameters.epsilon, 0, 1);
    require('maxAgeMinutes', parameters.maxAgeMinutes, 0, Number.MAX_SAFE_INTEGER, true);
    return parameters;
}
/**
 * Pure projection over an event list. Reading it never writes back, never emits a
 * new event and never touches the relationship axes; repeated reads cannot raise
 * the value. Every rejection path returns an explicit state instead of a guess.
 */
export function projectEroticInterest(events, nowMs, policy, parameters = EROTIC_INTEREST_DEFAULTS) {
    // Fixed precedence: an unacknowledged stop outranks a closed module, and an
    // unconfirmed adult range outranks a plain disabled switch.
    const blockReason = policy.stopped ? 'owner-stop' : !policy.adultsConfirmed ? 'adult-context-unknown' : !policy.enabled ? 'disabled' : null;
    const base = {
        version: 'erotic-interest-v1',
        atMs: Number.isFinite(nowMs) ? nowMs : 0,
        blocked: blockReason !== null,
        blockReason,
        parameterVersion: EROTIC_PARAMETER_VERSION
    };
    // A stop is a hard zero. Time, warmth, a re-extracted appraisal or an imported
    // old package must never revive it.
    if (blockReason === 'owner-stop')
        return { ...base, value: 0, evidenceIds: [] };
    // A closed module or an unconfirmed adult range is unknown, not a measured zero.
    if (blockReason !== null)
        return { ...base, value: null, evidenceIds: [] };
    const checked = checkedParameters(parameters);
    const gain = checked.gain;
    const halfLifeMs = checked.halfLifeMinutes * MINUTE;
    const epsilon = checked.epsilon;
    const maxAgeMs = checked.maxAgeMinutes * MINUTE;
    const at = base.atMs;
    const decay = (value, fromMs, toMs) => value * Math.pow(2, -(Math.max(0, toMs - fromMs)) / halfLifeMs);
    // Shape validation only. Window and status decisions belong to the revision race
    // below, because a canonical revision is selected before anything is excluded:
    // a future or retracted higher revision has to be able to cancel the active lower
    // one instead of being skipped and letting the stale contribution survive.
    const candidates = [];
    for (const event of events) {
        if (!event || typeof event !== 'object')
            throw Error('invalid erotic interest event');
        if (typeof event.sourceId !== 'string' || !event.sourceId)
            throw Error('erotic interest event requires a source id');
        if (!Number.isFinite(event.atMs))
            throw Error('erotic interest event requires a finite timestamp');
        if (typeof event.strength !== 'number' || !Number.isFinite(event.strength) || event.strength < 0 || event.strength > 1)
            throw Error('erotic interest strength must be a finite number in [0,1]');
        if (event.status !== undefined && event.status !== 'active' && event.status !== 'retracted')
            throw Error('invalid erotic interest event status');
        if (event.revision !== undefined && (!Number.isInteger(event.revision) || event.revision < 0))
            throw Error('invalid erotic interest event revision');
        candidates.push(event);
    }
    // Collapse each source to its highest revision first: a revision replaces the
    // earlier contribution instead of stacking on it.
    const groups = new Map();
    for (const event of candidates) {
        const group = groups.get(event.sourceId);
        if (group)
            group.push(event);
        else
            groups.set(event.sourceId, [event]);
    }
    const accepted = [];
    const signature = (event) => `${event.atMs}|${event.status ?? 'active'}|${event.strength}`;
    for (const group of groups.values()) {
        const top = Math.max(...group.map(revisionOf));
        const winners = group.filter(event => revisionOf(event) === top);
        // A same-revision disagreement cannot be resolved here. Timestamp, status and
        // strength all have to agree; otherwise drop the whole source instead of
        // silently picking one side.
        if (new Set(winners.map(signature)).size > 1)
            continue;
        const winner = winners[0];
        // The winning revision decides the whole source, so these three checks run after
        // the race and not before it.
        if ((winner.status ?? 'active') === 'retracted')
            continue;
        if (winner.atMs > at)
            continue;
        if (policy.epochMs > 0 && winner.atMs <= policy.epochMs)
            continue;
        accepted.push(winner);
    }
    if (!accepted.length)
        return { ...base, value: null, evidenceIds: [] };
    accepted.sort((a, b) => a.atMs - b.atMs || a.sourceId.localeCompare(b.sourceId));
    let value = 0;
    let lastMs = 0;
    const evidenceIds = [];
    for (const event of accepted) {
        value = Math.min(1, decay(value, lastMs, event.atMs) + gain * clamp01(event.strength));
        lastMs = event.atMs;
        evidenceIds.push(event.sourceId);
    }
    value = decay(value, lastMs, at);
    // Zeroing takes the earlier of the two independent bounds: the epsilon floor or
    // the hard retention limit. There is no rule that waits for the hard limit.
    const agedOut = at - lastMs >= maxAgeMs;
    if (agedOut || value < epsilon)
        return { ...base, value: 0, evidenceIds };
    return { ...base, value, evidenceIds };
}
//# sourceMappingURL=erotic-interest.js.map