import { PersonalityProfiles } from '../storage/personality-profiles.js';
const clamp = (value) => Math.max(0, Math.min(1, value));
/** Affection and an outgoing current persona may use the explicitly configured extra budget. */
export function proactiveFrequency(config, repos, principalId) {
    const state = repos.getSnapshot(principalId)?.snapshot;
    const personaId = repos.getSetting(`persona.id:${principalId}`) ?? 'builtin';
    const profile = new PersonalityProfiles(repos).get(config.companion.id, personaId);
    const traits = profile?.traits;
    const affection = clamp(state?.relationship.affection ?? 0);
    const liveliness = clamp(((state?.personality.initiative ?? traits?.initiative ?? .5) + (traits?.socialEnergy ?? .5) + (traits?.playfulness ?? .5)) / 3);
    const bond = clamp((affection - .5) / .5), outgoing = clamp((liveliness - .5) / .5);
    const grievance = clamp(state?.relationship.grievance ?? 0);
    const boost = config.proactive.adaptiveFrequency ? bond * outgoing * (1 - grievance) : 0;
    const baseline = config.proactive.spontaneousLimitPerDay;
    const ceiling = Math.max(baseline, config.proactive.adaptiveMaxDailyLimit);
    const baseGap = config.proactive.spontaneousMinGapMinutes;
    return {
        dailyLimit: baseline === 0 ? 0 : baseline + Math.floor((ceiling - baseline) * boost + .000001),
        minGapMinutes: Math.round(baseGap - Math.max(0, baseGap - config.proactive.adaptiveMinGapMinutes) * boost),
        affection, liveliness, boost,
        reason: boost > 0 ? '好感与当前活泼性格适度增加主动联系额度；静默和未回复暂停仍生效。' : '当前使用基础主动联系频率。',
    };
}
//# sourceMappingURL=frequency.js.map