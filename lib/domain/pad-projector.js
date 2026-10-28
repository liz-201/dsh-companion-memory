/** Engineering priors v1, NOT measured psychological coordinates. */
export const PAD_PRIORS = {
    admiration: [.5, .25, .1], anger: [-.6, .65, .2], disappointment: [-.6, -.2, -.3], distress: [-.6, .1, -.4], fear: [-.55, .6, -.45],
    'fears-confirmed': [-.65, .4, -.4], gloating: [.25, .2, .1], gratification: [.65, .35, .35], gratitude: [.6, .2, .1], 'happy-for': [.6, .25, .1],
    hate: [-.5, .3, .1], hope: [.35, .3, 0], joy: [.65, .3, .15], love: [.6, .1, .1], pity: [-.35, .1, -.2], pride: [.55, .3, .4], relief: [.6, -.3, .15],
    remorse: [-.6, .15, -.35], reproach: [-.45, .35, .15], resentment: [-.45, .35, -.1], satisfaction: [.6, -.1, .25], shame: [-.6, .15, -.5],
};
const clamp = (n) => Math.max(-1, Math.min(1, n));
/** Closed-form event convolution avoids read-frequency and integration-step drift. */
export function projectPad(events, atMs, halfLifeMinutes = 90, moodHalfLifeMinutes = 360) {
    const fast = [0, 0, 0], slow = [0, 0, 0];
    const k = Math.LN2 / (Math.max(1, halfLifeMinutes) * 60000), m = Math.LN2 / (Math.max(1, moodHalfLifeMinutes) * 60000);
    let controlKnown = false;
    for (const event of events) {
        if (event.atMs > atMs)
            continue;
        const age = Math.max(0, atMs - event.atMs), decay = Math.exp(-k * age);
        const convolution = Math.abs(k - m) < 1e-14 ? m * age * decay : m * (Math.exp(-m * age) - decay) / (k - m);
        // Compounds replace their base contributions to avoid counting the same appraisal twice.
        const compound = event.components.filter(c => ['anger', 'gratitude', 'gratification', 'remorse'].includes(c.category));
        for (const component of compound.length ? compound : event.components) {
            const prior = PAD_PRIORS[component.category];
            for (let axis = 0; axis < 3; axis++) {
                const value = axis === 2 && event.control !== undefined ? event.control * 2 - 1 : prior[axis];
                fast[axis] += value * component.intensity * decay;
                slow[axis] += value * component.intensity * convolution;
            }
            if (event.control !== undefined)
                controlKnown = true;
        }
    }
    const pad = (values) => ({ pleasure: clamp(values[0]), arousal: clamp(values[1]), dominance: clamp(values[2]) });
    return { emotion: pad(fast), mood: pad(slow), controlKnown };
}
//# sourceMappingURL=pad-projector.js.map