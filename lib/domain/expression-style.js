const unit = (value) => Math.max(0, Math.min(1, value));
/** Expression is a projection, never a mutation of personality or relationship. */
export function expressionProfile(state) {
    const { relationship: r, mood: m, personality: p } = state;
    const ease = unit(r.familiarity * 0.55 + r.trust * 0.3 + Math.max(0, r.affection) * 0.15 - m.tension * 0.2 - r.grievance * 0.25);
    const distress = Math.max(m.anger, m.hurt, m.tension * 0.7);
    return {
        ease,
        openness: unit(ease * 0.6 + m.joy * 0.25 + m.expressiveness * 0.15 - distress * 0.3),
        warmth: unit(p.warmth * 0.5 + Math.max(0, r.affection) * 0.2 + m.joy * 0.3 - distress * 0.35),
        tone: m.hurt >= 0.3 && m.hurt > m.anger ? 'hurt'
            : m.anger >= 0.3 ? 'angry'
                : m.tension >= 0.35 || r.trust < 0.3 ? 'guarded'
                    : m.joy >= 0.3 && ease >= 0.45 ? 'bright' : 'settled',
        playful: ease >= 0.55 && r.trust >= 0.6 && m.hurt < 0.25 && m.tension < 0.35 && r.grievance < 0.25,
        restrained: p.selfControl >= 0.65,
    };
}
/** Compact directions rather than canned dialogue or numeric status labels. */
export function renderExpressionStyle(state) {
    const style = expressionProfile(state);
    const closeness = style.ease < 0.3
        ? '还不熟，留些分寸，少自来熟；内向人设可短答，别擅自加亲昵称呼。'
        : style.ease < 0.55 ? '已有些熟悉，少些客套，可顺着具体话题多接一句。'
            : '相处已熟，接话放松直接；可以流露关心和小玩笑，不必反复确认关系。';
    const mood = style.tone === 'angry'
        ? (style.restrained ? '有气时措辞比平时直接、句子短些，仍保留原来的温柔底色。' : '有气时可以直说不满，但只谈这件事，不把每句话变成回怼。')
        : style.tone === 'hurt' ? '受伤时少一点玩笑，可简短说出在意的具体事情，不长篇剖白。'
            : style.tone === 'guarded' ? '有些戒备，表达审慎，别勉强热络或装作没事。'
                : style.tone === 'bright' ? '开心时接话更有兴致，可以自然多说一点，不机械撒娇。'
                    : style.warmth >= 0.55 ? '语气柔和，关注眼前这件小事，不堆甜话。' : '平常接话就好，不刻意表演情绪。';
    const humor = style.playful
        ? '共同用过或对方明确喜欢的梗，合适时偶尔接；有气也可轻轻顶一句，不固定口头禅。'
        : '不强套网络梗、脏话或亲密玩笑。';
    return [
        '表达参考，勿复述：保留当前人设。闲聊先接眼前这句话，通常一到三句；不用标题、分点、总结和满意度追问，不播报情感等级。正事及明确的详细说明要求优先。',
        closeness, mood, humor,
        '不编共同经历，不借吃醋或离不开对方施压；不假称真人。',
    ].join('\n');
}
//# sourceMappingURL=expression-style.js.map