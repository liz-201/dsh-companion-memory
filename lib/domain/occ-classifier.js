export const OCC_CATEGORIES = ['admiration', 'anger', 'disappointment', 'distress', 'fear', 'fears-confirmed', 'gloating', 'gratification', 'gratitude', 'happy-for', 'hate', 'hope', 'joy', 'love', 'pity', 'pride', 'relief', 'remorse', 'reproach', 'resentment', 'satisfaction', 'shame'];
/** Classification uses validated situational evidence, never emotional keywords. */
export function classifyOcc(a, prior) {
    const labels = new Set(), displays = [], reasons = [];
    if (a.confidence < .65 || (a.relevance !== undefined && a.relevance < .15))
        return { components: [], displays, reasons: ['insufficient-evidence'] };
    const positive = (n) => n !== undefined && n > .15;
    const negative = (n) => n !== undefined && n < -.15;
    const d = a.desirability;
    if (a.focus === 'event') {
        if (a.affectedParty === 'other' || a.affectedParty === 'owner') {
            if (positive(a.likingForOther) && positive(a.desirabilityForOther))
                labels.add('happy-for');
            if (positive(a.likingForOther) && negative(a.desirabilityForOther))
                labels.add('pity');
            if (negative(a.likingForOther) && positive(a.desirabilityForOther) && negative(a.deservingness))
                labels.add('resentment');
            if (negative(a.likingForOther) && negative(a.desirabilityForOther))
                labels.add('gloating');
        }
        if (a.prospect === 'pending' && a.likelihood !== undefined && a.likelihood > 0 && a.likelihood < 1) {
            if (positive(d))
                labels.add('hope');
            if (negative(d))
                labels.add('fear');
        }
        else if (a.prospect === 'confirmed' || a.prospect === 'disconfirmed') {
            if (prior?.prospect === 'pending') {
                if (positive(prior.desirability))
                    labels.add(a.prospect === 'confirmed' ? 'satisfaction' : 'disappointment');
                if (negative(prior.desirability))
                    labels.add(a.prospect === 'confirmed' ? 'fears-confirmed' : 'relief');
            }
            else
                reasons.push('missing-prior-expectation');
        }
        else if (a.affectedParty === 'self') {
            if (positive(d))
                labels.add('joy');
            if (negative(d))
                labels.add('distress');
        }
    }
    if (a.focus === 'action') {
        if (a.agency === 'self') {
            if (positive(a.praiseworthiness))
                labels.add('pride');
            if (negative(a.praiseworthiness))
                labels.add('shame');
            if (positive(d) && positive(a.praiseworthiness))
                labels.add('gratification');
            if (negative(d) && negative(a.praiseworthiness))
                labels.add('remorse');
        }
        else if (a.agency === 'owner' || a.agency === 'other') {
            if (positive(a.praiseworthiness))
                labels.add('admiration');
            if (negative(a.praiseworthiness))
                labels.add('reproach');
            if (positive(d) && positive(a.praiseworthiness))
                labels.add('gratitude');
            if (negative(d) && negative(a.praiseworthiness))
                labels.add('anger');
        }
    }
    if (a.focus === 'object') {
        if (positive(a.appealingness))
            labels.add('love');
        if (negative(a.appealingness))
            labels.add('hate');
    }
    if ((a.unfairness ?? 0) >= .7 && negative(d) && a.agency !== 'self')
        displays.push('委屈');
    if ((a.helplessness ?? 0) >= .7 && (labels.has('pity') || negative(d)))
        displays.push('心酸');
    if (labels.has('remorse'))
        displays.push('愧疚');
    if ((a.relationshipThreat ?? 0) >= .75 && negative(d))
        displays.push('吃味');
    if ((a.personalAttention ?? 0) >= .7 && labels.has('gratitude'))
        displays.push('被重视感');
    if (labels.has('relief'))
        displays.push('安心');
    // 失落 needs a failed positive expectation; plain distress carries no goal-frustration evidence yet.
    if (labels.has('disappointment'))
        displays.push('失落');
    const magnitude = Math.max(...[d, a.praiseworthiness, a.appealingness, a.desirabilityForOther, prior?.desirability].filter((n) => n !== undefined).map(Math.abs), .15);
    return { components: [...labels].map(category => ({ category, intensity: Math.min(1, magnitude * a.confidence * (a.relevance ?? .7)) })), displays, reasons };
}
//# sourceMappingURL=occ-classifier.js.map