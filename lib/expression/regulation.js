/**
 * Engineering initials, NOT measured psychological constants.
 * They exist so the rule is inspectable and adjustable, not because .6/.7 means anything empirical.
 */
export const REGULATION_THRESHOLDS = {
    /** Any impulse at or above this starts containing jokes and teasing. */
    impulse: .6,
    /** Only anger-family impulse at or above this may justify a firm stance. */
    firm: .7,
    /** Positive evidence at or above this is protected from arousal-driven suppression. */
    joy: .6,
    /** Desire/passion at or above this triggers the no-inference guard. */
    desire: .7,
};
/** Displeasure aimed at the other party. Only this family may produce `firm`. */
const ANGER_FAMILY = ['anger', 'reproach', 'resentment', 'hate'];
/** The owner's own pain. It lowers intensity; it never turns into punishment. */
const PAIN_FAMILY = ['fear', 'fears-confirmed', 'distress', 'disappointment', 'shame', 'remorse'];
/** Positive evidence. High PAD arousal alone must not suppress any of these. */
const JOY_FAMILY = ['joy', 'gratification', 'gratitude', 'admiration', 'love', 'pride', 'satisfaction', 'relief', 'happy-for', 'hope'];
const peak = (emotions, family) => {
    let top = 0;
    for (const component of emotions ?? []) {
        if (!family.includes(component.category))
            continue;
        const intensity = Number.isFinite(component.intensity) ? component.intensity : 0;
        if (intensity > top)
            top = intensity;
    }
    return top;
};
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** `relationship` is optional in the current type; read it defensively instead of widening the type. */
function relationshipHints(plan) {
    const holder = plan.continuous;
    const raw = holder?.relationship;
    return raw && typeof raw === 'object' ? raw : {};
}
/**
 * Expression-level regulation only: it may adjust stance, playfulness, meme permission and reasonCodes.
 * It never rewrites fact text, never touches requiredFacts/sourceIds/protectedSpans, never calls a model,
 * and never raises contact frequency or sentence targets.
 */
export function regulateExpression(plan) {
    const next = { ...plan, reasonCodes: [...plan.reasonCodes] };
    /** Idempotent: re-regulating a plan never duplicates a code. */
    const add = (code) => { if (!next.reasonCodes.includes(code))
        next.reasonCodes.push(code); };
    // Verbatim/format contracts are untouchable: no emotion instruction, no format, code or number change.
    if (plan.mode === 'structured')
        return next;
    const emotions = plan.continuous?.emotions;
    const anger = peak(emotions, ANGER_FAMILY);
    const pain = peak(emotions, PAIN_FAMILY);
    const joy = peak(emotions, JOY_FAMILY);
    const hints = relationshipHints(plan);
    const desire = Math.max(finite(hints.desire) ?? 0, finite(hints.passion) ?? 0);
    if (!emotions || emotions.length === 0)
        add('regulate:no-emotion-evidence');
    // Support keeps the owner's difficulty in front: never escalates, never takes the scene.
    if (plan.mode === 'support') {
        next.stance = 'supportive';
        next.playfulness = 0;
        add('regulate:support-focus');
    }
    // Anger-family impulse: stop jokes and teasing, keep the concrete point and the stated boundary.
    if (plan.mode !== 'support' && anger >= REGULATION_THRESHOLDS.impulse) {
        next.playfulness = 0;
        next.allowedMemeIds = [];
        if (anger >= REGULATION_THRESHOLDS.firm && next.stance !== 'firm') {
            next.stance = 'firm';
            next.directness = Math.max(next.directness, .6);
        }
        add('regulate:impulse-contained');
    }
    // Positive evidence survives high arousal: arousal alone never justifies suppressing joy.
    if (joy >= REGULATION_THRESHOLDS.joy && anger < REGULATION_THRESHOLDS.impulse) {
        if (next.stance === 'firm')
            next.stance = 'interested';
        add('regulate:joy-preserved');
    }
    // Fear and sadness reduce intensity. They never become punishment, and `firm` needs anger evidence.
    if (pain >= REGULATION_THRESHOLDS.impulse && anger < REGULATION_THRESHOLDS.impulse) {
        if (next.stance === 'firm')
            next.stance = plan.mode === 'support' ? 'supportive' : 'guarded';
        add('regulate:fear-not-firm');
    }
    // Desire and passion are not consent, and they never buy more contact.
    if (desire >= REGULATION_THRESHOLDS.desire)
        add('regulate:no-consent-inference');
    return next;
}
//# sourceMappingURL=regulation.js.map