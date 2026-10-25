import { expressionProfile } from './expression-style.js';
import { NEUTRAL } from './personality-profile.js';
import { taskMode } from '../expression/task-mode.js';
import { turnCue } from './appraisal-context.js';
const unit = (value) => Math.max(0, Math.min(1, value));
export function projectExpression(input) {
    const { state } = input;
    const exposure = input.contactExposure;
    const observedFamiliarity = exposure ? .1 + .45 * (1 - Math.exp(-Math.max(0, exposure.messages) / 60)) + .25 * (1 - Math.exp(-Math.max(0, exposure.days) / 14)) : 0;
    const profile = expressionProfile({ ...state, relationship: { ...state.relationship, familiarity: Math.max(state.relationship.familiarity, observedFamiliarity) } }), traits = input.profile?.traits ?? { ...NEUTRAL, ...state.personality };
    const mode = taskMode(input.userText), cue = turnCue(input.userText);
    let stance = profile.tone === 'hurt' ? 'hurt' : profile.tone === 'angry' ? 'firm' : profile.tone === 'guarded' ? 'guarded' : profile.tone === 'bright' ? 'interested' : 'neutral';
    if (mode === 'support' || cue.intent === 'distress')
        stance = 'supportive';
    const previous = input.previous;
    if (previous && stance !== previous.stance && mode === previous.mode && Math.abs(profile.ease - previous.ease) < .05 && Math.max(state.mood.anger, state.mood.hurt, state.mood.joy, state.mood.tension) < .35 && cue.intent === 'none')
        stance = previous.stance;
    const openness = unit(profile.openness * .65 + traits.socialEnergy * .2 + (1 - traits.reserve) * .15);
    return {
        ruleVersion: 'expression-v2', principalId: state.principalId, personalityRevisionId: input.profile?.revisionId ?? 'legacy', stateRevision: state.revision,
        mode, stance, ease: profile.ease, openness, warmth: profile.warmth, directness: unit(traits.directness + (stance === 'firm' ? .1 : 0)),
        playfulness: profile.playful && cue.intent === 'none' && !['support', 'structured', 'task'].includes(mode) ? traits.playfulness : 0,
        reserve: traits.reserve, conscientiousness: traits.conscientiousness, curiosity: traits.curiosity, optimism: traits.optimism,
        targetSentences: mode === 'chat' ? { min: 1, max: openness > .65 ? 5 : 3 } : null,
        addressHabitId: null, allowedMemeIds: [], requiredFacts: [], sourceIds: [], protectedSpans: [],
        ruleIds: ['preserve-meaning', 'no-state-report', 'no-invented-history', 'respect-task-format', 'no-emotional-pressure'],
        reasonCodes: [mode, stance, cue.intent, profile.ease < .3 ? 'unfamiliar' : profile.ease < .55 ? 'acquainted' : 'familiar'],
    };
}
//# sourceMappingURL=expression-plan.js.map