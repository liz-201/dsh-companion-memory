/** All values are product initial values awaiting calibration, not study norms. */
export const RELATIONSHIP_DYNAMICS_DEFAULTS = Object.freeze({
    initialIntimacy: .15,
    intimacyGain: .05,
    desireGain: .25,
    desireHalfLifeMinutes: 180,
    passionHalfLifeMinutes: 60,
    passionIntimacyGain: 2,
    passionPullGain: .2,
    withdrawalDesireLoss: .75,
    withdrawalPassionLoss: 1,
    separationPassionLoss: 2,
});
const unit = (value) => Math.max(0, Math.min(1, value));
const timestamp = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const signal = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1;
const compareSource = (a, b) => a.atMs - b.atMs || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
function parametersFor(overrides) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.keys(overrides).some(key => !Object.hasOwn(RELATIONSHIP_DYNAMICS_DEFAULTS, key)))
        throw Error('Invalid relationship parameters');
    const parameters = { ...RELATIONSHIP_DYNAMICS_DEFAULTS, ...overrides };
    for (const key of Object.keys(RELATIONSHIP_DYNAMICS_DEFAULTS)) {
        const value = parameters[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw Error(`Invalid relationship parameter: ${key}`);
        if (key === 'desireHalfLifeMinutes' || key === 'passionHalfLifeMinutes') {
            if (value <= 0 || !Number.isFinite(value * 60000))
                throw Error(`Invalid relationship parameter: ${key}`);
        }
        else if ((key === 'initialIntimacy' || key === 'intimacyGain' || key === 'desireGain' || key === 'passionPullGain'
            || key === 'withdrawalDesireLoss' || key === 'withdrawalPassionLoss') && value > 1)
            throw Error(`Invalid relationship parameter: ${key}`);
        else if ((key === 'passionIntimacyGain' || key === 'separationPassionLoss') && value > 4)
            throw Error(`Invalid relationship parameter: ${key}`);
    }
    return parameters;
}
function sourceEvent(event) {
    if (!event || typeof event !== 'object' || typeof event.sourceId !== 'string' || !event.sourceId.trim()
        || event.sourceId.length > 500 || /[\u0000-\u001f]/u.test(event.sourceId) || !timestamp(event.atMs))
        throw Error('Invalid relationship source');
    if (event.intimacyDelta !== undefined && !signal(event.intimacyDelta) || event.pull !== undefined && !signal(event.pull))
        throw Error('Invalid relationship signal');
    const revision = event.revision === undefined ? 0 : event.revision, status = event.status === undefined ? 'active' : event.status;
    if (!Number.isSafeInteger(revision) || revision < 0 || !['active', 'retracted'].includes(status))
        throw Error('Invalid relationship source revision');
    return { sourceId: event.sourceId, atMs: event.atMs, intimacyDelta: event.intimacyDelta ?? 0, pull: event.pull ?? 0, revision, status };
}
/**
 * Recompute from authoritative sources; never persist a read projection as a
 * new input event. Removing a source or supplying a retracted higher revision
 * removes its effects on the next replay. No idle term changes intimacy.
 */
export function projectRelationshipDynamics(events, nowMs, overrides = {}) {
    if (!Array.isArray(events) || !timestamp(nowMs))
        throw Error('Invalid relationship projection time or history');
    const parameters = parametersFor(overrides);
    const sources = new Map();
    const conflicts = new Set();
    // Filter future sources before choosing revisions: future data cannot alter a
    // projection of the past. Callers supply original source time for corrections.
    for (const candidate of events) {
        const event = sourceEvent(candidate);
        if (event.atMs > nowMs)
            continue;
        const previous = sources.get(event.sourceId);
        if (!previous || event.revision > previous.revision) {
            sources.set(event.sourceId, event);
            conflicts.delete(event.sourceId);
        }
        else if (event.revision === previous.revision && (event.atMs !== previous.atMs || event.intimacyDelta !== previous.intimacyDelta
            || event.pull !== previous.pull || event.status !== previous.status))
            conflicts.add(event.sourceId);
    }
    if (conflicts.size > 0)
        throw Error('Conflicting relationship source revision');
    const history = [...sources.values()].filter(event => event.status === 'active').sort(compareSource);
    let intimacy = parameters.initialIntimacy, desire = 0, passion = 0, atMs = history[0]?.atMs ?? nowMs;
    const evidenceIds = [];
    const decayTo = (time) => {
        const elapsed = Math.max(0, time - atMs);
        desire *= Math.pow(2, -elapsed / (parameters.desireHalfLifeMinutes * 60000));
        passion *= Math.pow(2, -elapsed / (parameters.passionHalfLifeMinutes * 60000));
        atMs = time;
    };
    for (let index = 0; index < history.length;) {
        const time = history[index].atMs;
        decayTo(time);
        let intimacySignal = 0, positivePull = 0, negativePull = 0;
        // Same-millisecond sources are distinct. Batch aggregation avoids an
        // arbitrary ID ordering changing the result at a clamp or withdrawal gate.
        while (index < history.length && history[index].atMs === time) {
            const event = history[index++];
            intimacySignal += event.intimacyDelta;
            positivePull += Math.max(0, event.pull);
            negativePull += Math.max(0, -event.pull);
            if (event.intimacyDelta !== 0 || event.pull !== 0)
                evidenceIds.push(event.sourceId);
        }
        const nextIntimacy = unit(intimacy + parameters.intimacyGain * intimacySignal);
        const change = nextIntimacy - intimacy;
        intimacy = nextIntimacy;
        if (negativePull > 0) {
            // Explicit withdrawal dominates competing approach signals at this time.
            desire = unit(desire - parameters.withdrawalDesireLoss * negativePull);
            passion = unit(passion - parameters.withdrawalPassionLoss * negativePull);
        }
        else {
            desire = unit(desire + parameters.desireGain * positivePull);
            if (change >= 0)
                passion = unit(passion + parameters.passionIntimacyGain * change + parameters.passionPullGain * positivePull);
        }
        // Separation never becomes a positive passion stimulus via abs(dI/dt).
        if (change < 0)
            passion = unit(passion + parameters.separationPassionLoss * change);
    }
    decayTo(nowMs);
    return { atMs: nowMs, intimacy, desire, passion, evidenceIds, sourceCount: history.length, parameterVersion: 'relationship-engineering-v1' };
}
//# sourceMappingURL=relationship-dynamics.js.map