/** Compatibility view from identified OCC components; PAD alone is not invertible. */
export function continuousMood(state, fallback) {
    if (!state?.emotions.length)
        return { ...fallback };
    const maximum = (categories) => Math.max(0, ...state.emotions.filter(e => categories.includes(e.category)).map(e => e.intensity));
    return {
        anger: maximum(['anger', 'reproach', 'hate', 'resentment']),
        hurt: maximum(['distress', 'disappointment', 'remorse', 'shame', 'pity', 'fears-confirmed']),
        joy: maximum(['joy', 'happy-for', 'gratitude', 'gratification', 'satisfaction', 'relief', 'pride', 'admiration', 'love']),
        tension: maximum(['fear', 'fears-confirmed']),
        expressiveness: Math.max(.2, Math.min(1, maximum(state.emotions.map(e => e.category)))),
    };
}
/** Both real ingress paths use this view; factual-query scoring remains zero. */
export function retrievalArousal(state, fallback) {
    if (state?.emotions.length)
        return Math.max(0, Math.min(1, state.pad.emotion.arousal));
    return Math.max(0, Math.min(1, fallback.anger * .5 + fallback.tension * .3 + fallback.hurt * .2));
}
//# sourceMappingURL=continuous-mood.js.map