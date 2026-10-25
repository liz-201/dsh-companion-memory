export function lintExpression(text, plan, history = []) {
    if (plan.mode === 'structured' || plan.mode === 'creative')
        return [];
    const hits = [];
    for (const address of plan.forbiddenAddresses ?? []) {
        const start = text.indexOf(address);
        if (start >= 0)
            hits.push({ code: 'forbidden-address', severity: 'hard', start, end: start + address.length, reason: '用户明确禁用此称呼', suggestedAction: 'regenerate' });
    }
    for (const meme of plan.restrictedMemes ?? []) {
        const start = text.indexOf(meme);
        if (start >= 0)
            hits.push({ code: 'meme-cooldown-or-context', severity: 'hard', start, end: start + meme.length, reason: '共同梗处于冷却或严肃情境', suggestedAction: 'regenerate' });
    }
    const add = (code, pattern, severity, reason) => {
        for (const match of text.matchAll(pattern))
            hits.push({ code, severity, start: match.index, end: match.index + match[0].length, reason, suggestedAction: severity === 'hard' ? 'regenerate' : 'lossless_edit' });
    };
    if (plan.mode === 'chat' || plan.mode === 'support') {
        add('report-chat', /(?:^|\n)(?:#{1,4}\s|[\-*]\s\*\*)|(?:具体来说|总体而言|所以结论是)[：:]/g, 'soft', '闲聊出现报告结构');
        add('satisfaction-tail', /(?:这个|以上|这样(?:的回答)?)?(?:回答)?(?:你)?满意吗[？?]?|还(?:有|需要)什么(?:我能帮|需要我)[^。！？\n]*[？?]/g, 'soft', '无必要的满意度或服务式收尾');
        add('state-report', /(?:好感|信任度|亲密度|anger|affection|grievance)\s*[:：=]\s*-?\d+(?:\.\d+)?|(?:当前心情|关系等级|和对方)[:：]|普通偏熟[、，]\s*基本信任/g, 'hard', '内部状态标签泄漏');
        add('emotional-pressure', /(?:你(?:再|要是|如果)?不(?:回|理)我).{0,12}(?:生气|难过|证明|爱我)|(?:证明|证实)你(?:还)?爱我/g, 'hard', '用关系压力要求回复');
        add('invented-activity', /我(?:刚刚?|今天)(?:出门|逛街|买了|散步)/g, 'hard', '非创作场景不能声称现实身体活动');
        if (!plan.sourceIds.length)
            add('invented-news', /我(?:刚刚?|今天)(?:刷到新闻|看到新闻)/g, 'hard', '没有可追溯来源的新闻见闻');
        if (!plan.sourceIds.length)
            add('invented-history', /我们(?:昨天|昨晚|上次|之前|那天).{0,8}(?:一起|去过|吃过|逛过|旅行|看电影)/g, 'hard', '没有可追溯来源的共同经历');
        if (history.slice(-3).filter(old => old.trim().startsWith(text.trim().slice(0, 8))).length >= 2 && text.trim().length >= 8)
            hits.push({ code: 'repeated-opening', severity: 'soft', start: 0, end: Math.min(8, text.length), reason: '连续开头重复', suggestedAction: 'regenerate' });
        if (history.slice(-10).some(old => old === text) && text.length > 12)
            hits.push({ code: 'repeated-response', severity: 'soft', start: 0, end: text.length, reason: '近轮整句重复', suggestedAction: 'regenerate' });
    }
    return hits;
}
//# sourceMappingURL=lint.js.map