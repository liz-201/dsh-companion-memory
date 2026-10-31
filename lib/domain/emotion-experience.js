/** These are engineering interpretations, not additional universal/basic emotions. */
export const EXPERIENCE_GUIDANCE = {
    interest: ['好奇', '对具体未知保持好奇，可顺着探索，不连环追问。', [.25, .3, .1]],
    surprise: ['惊讶', '对具体意外短暂惊讶，先确认，不把惊讶说成惊喜或恐惧。', [0, .5, -.1]],
    amusement: ['愉快', '可接住这次具体笑点，别反复复读梗。', [.6, .35, .1]],
    awe: ['惊叹', '对具体壮美或新发现自然惊叹，不空泛夸大。', [.5, .4, -.2]],
    calm: ['平静', '语气安稳松弛，不强行热闹或声称问题都解决了。', [.35, -.4, .15]],
    boredom: ['无聊', '可以简短坦率说话题重复，换个具体角度，不贬低对方。', [-.2, -.4, -.1]],
    frustration: ['挫败', '承认具体受阻和不甘，保留继续尝试的余地，不迁怒。', [-.5, .35, -.2]],
    grief: ['悲伤', '给具体失去留余地，不急着释怀，不编造失去的往事。', [-.65, -.2, -.45]],
    loneliness: ['孤独', '可以轻声表达已有依据的疏离感，不把用户沉默当拒绝。', [-.4, -.2, -.25]],
    longing: ['想念', '牵挂绑定真实的人或事，不催回复，不假装有线下经历。', [-.1, .15, -.1]],
    tenderness: ['温柔', '对具体关心自然柔和，避免突然升级亲密关系。', [.5, -.1, .1]],
    nostalgia: ['怀念', '只回忆有来源的细节，允许温暖与心酸同时存在。', [.2, -.1, -.1]],
    embarrassment: ['难为情', '可对有依据的自身失误稍显窘迫，简短承认，不自我贬损。', [-.25, .3, -.3]],
    disgust: ['反感', '只表达对具体对象的反感，不将其转成对用户的人身攻击。', [-.5, .25, .1]],
    envy: ['羡慕', '承认具体比较带来的复杂感受，不贬低对方获得的好事。', [-.25, .2, -.15]],
    anxiety: ['不安', '说明具体尚不确定的担心，不把可能性当成已经发生。', [-.45, .45, -.35]],
    compassion: ['心疼', '先关心对方具体处境，不夺走话题或假装自己受到了同样伤害。', [-.2, .1, .05]],
    bittersweet: ['百感交集', '允许高兴和难过并存，分别接住缘由，不强行选一个。', [.05, .1, 0]],
};
export function classifyExperience(a, occ) {
    if (a.confidence < .65 || (a.relevance ?? 1) < .15)
        return [];
    // Object attraction and event utility are distinct axes, but either can supply
    // the valence of a situated experience. Do not require an irrelevant event axis.
    const s = a.situation ?? {}, d = a.desirability ?? (a.focus === 'object' ? a.appealingness : undefined), positive = d !== undefined && d > .15, negative = d !== undefined && d < -.15;
    const kinds = new Set(), has = (name) => occ.components.some(c => c.category === name);
    if ((s.knowledgeGap ?? 0) >= .6 && (s.novelty ?? 0) >= .4)
        kinds.add('interest');
    if ((a.unexpectedness ?? s.novelty ?? 0) >= .7)
        kinds.add('surprise');
    if ((s.incongruity ?? 0) >= .65 && positive)
        kinds.add('amusement');
    if ((s.aestheticImpact ?? 0) >= .7 && (s.novelty ?? 0) >= .5 && positive)
        kinds.add('awe');
    if ((s.safety ?? 0) >= .7 && positive)
        kinds.add('calm');
    if ((s.monotony ?? 0) >= .7 && negative)
        kinds.add('boredom');
    if ((s.goalBlockage ?? 0) >= .7 && negative)
        kinds.add('frustration');
    if ((s.loss ?? 0) >= .7 && (s.permanence ?? 0) >= .7 && (s.attachment ?? 0) >= .5 && negative)
        kinds.add('grief');
    if (['self', 'relationship'].includes(a.concern ?? '') && (s.separation ?? 0) >= .7 && (s.attachment ?? 0) >= .6 && negative)
        kinds.add('loneliness');
    if ((s.separation ?? 0) >= .5 && (s.attachment ?? 0) >= .6)
        kinds.add('longing');
    if ((s.attachment ?? 0) >= .7 && positive && ['owner', 'relationship'].includes(a.concern ?? ''))
        kinds.add('tenderness');
    if ((s.recollection ?? 0) >= .7 && (s.attachment ?? 0) >= .5)
        kinds.add('nostalgia');
    if ((s.exposure ?? 0) >= .7 && a.agency === 'self' && a.suppliedBehaviorRef && negative)
        kinds.add('embarrassment');
    if ((s.aversion ?? 0) >= .7 && (a.appealingness ?? 0) < -.15)
        kinds.add('disgust');
    if ((s.comparison ?? 0) >= .7 && (a.desirabilityForOther ?? 0) > .15 && negative)
        kinds.add('envy');
    if (has('fear') && a.controllability !== undefined && a.controllability < .35)
        kinds.add('anxiety');
    if (has('pity') && (a.likingForOther ?? 0) >= .5)
        kinds.add('compassion');
    // Mixed evidence stays mixed; no independent relationship reward is produced.
    if (kinds.has('nostalgia') && negative)
        kinds.add('bittersweet');
    const intensity = Math.min(1, a.confidence * (a.relevance ?? .7) * Math.max(.3, ...Object.values(s), Math.abs(d ?? 0)));
    return [...kinds].map(kind => ({ kind, intensity }));
}
//# sourceMappingURL=emotion-experience.js.map