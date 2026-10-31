import { tokenize } from '../memory/normalizer.js';
import { projectPad } from './pad-projector.js';
import { EXPERIENCE_GUIDANCE } from './emotion-experience.js';
/** Attention changes expression, never the authoritative feeling, fact or relationship. */
export function attendAffect(state, query) {
    if (!state?.contexts)
        return state;
    const words = new Set(tokenize(query).tokens.filter(word => word.length >= 2 && !['我们', '你们', '这个', '那个', '什么', '之前', '现在', '今天', '自己', '觉得', '有点'].includes(word)));
    const relevant = state.contexts.filter(context => context.concern !== 'topic'
        || context.topic.length > 0 && !['我', '你', '他', '她', '它', '这个', '那个'].includes(context.topic) && query.includes(context.topic)
        || tokenize(context.topic).tokens.some(word => word.length >= 2 && words.has(word)));
    const emotions = new Map(), experiences = new Map();
    const displays = new Set();
    let directedAnger = 0;
    for (const context of relevant) {
        for (const e of context.emotions) {
            emotions.set(e.category, Math.min(1, (emotions.get(e.category) ?? 0) + e.intensity));
            if (context.concern === 'relationship' && ['anger', 'reproach', 'resentment'].includes(e.category))
                directedAnger = Math.max(directedAnger, e.intensity);
        }
        for (const e of context.experiences)
            experiences.set(e.kind, Math.min(1, (experiences.get(e.kind) ?? 0) + e.intensity));
        for (const label of context.displays)
            displays.add(label);
    }
    const attendedPad = projectPad(relevant.map(context => {
        const tone = [0, 0, 0];
        for (const e of context.experiences)
            for (let axis = 0; axis < 3; axis++)
                tone[axis] += EXPERIENCE_GUIDANCE[e.kind][2][axis] * e.intensity / context.experiences.length;
        return { atMs: 0, components: context.emotions, experienceTone: tone };
    }), 0);
    return { ...state, pad: { ...state.pad, emotion: attendedPad.emotion }, emotions: [...emotions].map(([category, intensity]) => ({ category, intensity })).sort((a, b) => b.intensity - a.intensity), experiences: [...experiences].map(([kind, intensity]) => ({ kind, intensity })).sort((a, b) => b.intensity - a.intensity), displays: [...displays], contexts: relevant, ownerDirectedAnger: directedAnger };
}
//# sourceMappingURL=affect-attention.js.map