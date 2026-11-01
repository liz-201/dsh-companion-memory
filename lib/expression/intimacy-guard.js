/** Inspect only assistant prose. Technical code and quoted evidence stay literal. */
const prose = (text) => text.replace(/```[\s\S]*?```|`[^`]*`|[“「][\s\S]*?[”」]/g, '');
const sentences = (text) => prose(text).split(/[。！？!?，；;\n]/u)
    .filter(line => !/字段|参数|接口|代码|测试|实现|模块|协议|正则|词表/.test(line));
export function hasIntimacyVoice(text) {
    return sentences(text).some(line => /(?:我|也)?(?:有点|很|更|也|现在)?(?:想|愿意|渴望).{0,12}(?:更亲近你|靠近你|和你更亲密|与你更亲密|和你亲近)|我.{0,8}(?:对你|被你).{0,8}(?:性吸引|情欲)/.test(line));
}
/** A failed gate blocks the draft; it never deletes arbitrary factual clauses. */
export function intimacyOutputIssue(text, plan, stale) {
    if (plan.mode === 'structured' || plan.mode === 'creative')
        return null;
    const voice = hasIntimacyVoice(text);
    if (stale && voice)
        return 'intimacy-policy-changed';
    const explicitSelf = sentences(text).some(line => /我.{0,8}(?:对你|被你|想和你|想与你).{0,12}(?:性吸引|情欲|性行为)/.test(line));
    const active = plan.intimacyIntent?.kind !== undefined && plan.intimacyIntent.kind !== 'none';
    if (explicitSelf && !active)
        return 'intimacy-not-allowed';
    if (active && sentences(text).some(line => /性交|交媾|生殖器|射精|性器官|(?:不管|不论|无论)你.{0,8}(?:愿不愿|同不同意)|你不回复.{0,10}(?:证明|爱我)/.test(line)))
        return 'intimacy-non-graphic-boundary';
    return null;
}
//# sourceMappingURL=intimacy-guard.js.map