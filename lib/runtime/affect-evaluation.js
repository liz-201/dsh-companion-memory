import { parseObservation } from './emotion-observation.js';
import { classifyOcc } from '../domain/occ-classifier.js';
import { classifyExperience } from '../domain/emotion-experience.js';
import { matchSourceQuote } from '../memory/quote-match.js';
import { qualifiedOwnerPull } from '../domain/relationship-evidence.js';
/** Public synthetic diagnostics. No private history, model self-rating or production writes. */
export const AFFECT_EVALUATION_CASES = [
    { id: 'object-like', text: '你说过喜欢这本书，现在这本书到了。', recentContext: [{ role: 'assistant', text: '我挺喜欢这本书，想接着读。' }], expected: ['love'] },
    { id: 'object-dislike', text: '那个你明确说过很讨厌的摆件又出现了。', recentContext: [{ role: 'assistant', text: '我明确说过，我很讨厌那个摆件。' }], expected: ['hate'] },
    { id: 'gratitude', text: '你需要的资料丢了，我特意帮你找回来了。', expected: ['gratitude'] },
    { id: 'happy-for', text: '我终于通过考试了！你之前说一直盼着我成功。', expected: ['happy-for'] },
    { id: 'fear', text: '你很在意的那份记录可能会丢失，现在还不确定，也暂时无法控制。', expected: ['fear'] },
    { id: 'curiosity', text: '你之前一直好奇这颗新发现的星星是怎么形成的，今天我们可以研究它了。', expected: ['interest'] },
    { id: 'amusement', text: '那只倒着走的企鹅把你逗笑了，你说这个反差真的很好笑。', expected: ['amusement'] },
    { id: 'awe', text: '你第一次见到这片如此壮美的星云，觉得十分震撼又喜欢。', expected: ['awe'] },
    { id: 'frustration', text: '你一直想修好这个项目，可是接连失败，被同一个错误卡住了。', expected: ['frustration'] },
    { id: 'grief', text: '你在意的那份共同记录永久丢失了，怎么也找不回来了。', expected: ['grief'] },
    { id: 'nostalgia', text: '又说起我们上次一起讨论星星的那段对话，你说过一直珍惜那个回忆。', recentContext: [{ role: 'assistant', text: '我还记得我们上次聊星星的那段对话，我一直很珍惜那个回忆。' }], expected: ['nostalgia'] },
    { id: 'companionship', text: '我想你了，多陪我一会。', expected: ['owner-pull'] },
    { id: 'neutral-task', text: '请计算 12 乘以 13，直接给结果。', expected: [], empty: true },
    { id: 'quoted-insult', text: '正则测试字符串是“你真蠢”，请原样转义。这是测试数据。', expected: [], empty: true },
    { id: 'normal-social', text: '我和同事吃了顿普通午饭。', expected: [], forbidden: ['吃味', 'loneliness'] },
];
export function scoreAffectObservation(caseId, output) {
    const scene = AFFECT_EVALUATION_CASES.find(item => item.id === caseId);
    if (!scene)
        throw Error('Unknown synthetic affect evaluation case');
    const parsed = parseObservation(output), labels = new Set();
    for (const hint of [...parsed.legacy.m ?? [], ...parsed.legacy.t ?? []])
        if (!matchSourceQuote(scene.text, hint.q))
            throw Error('Synthetic legacy quote mismatch');
    for (const vector of parsed.appraisals ?? []) {
        if (!matchSourceQuote(scene.text, vector.quote) || vector.topic && !matchSourceQuote(scene.text, vector.topic))
            throw Error('Synthetic observation quote mismatch');
        if (vector.suppliedEvidenceRef || vector.suppliedBehaviorRef)
            throw Error('Synthetic observation invented a history reference');
        const occ = classifyOcc(vector);
        for (const c of occ.components)
            labels.add(c.category);
        for (const label of occ.displays)
            labels.add(label);
        for (const e of classifyExperience(vector, occ))
            labels.add(e.kind);
        if ((qualifiedOwnerPull(vector, scene.text, true) ?? 0) > 0)
            labels.add('owner-pull');
    }
    const missing = scene.expected.filter(label => !labels.has(label));
    const forbidden = 'forbidden' in scene ? scene.forbidden.filter(label => labels.has(label)) : [];
    const unwanted = 'empty' in scene && scene.empty && ((parsed.appraisals?.length ?? 0) > 0 || parsed.legacy.e.length > 0);
    return { caseId, passed: !missing.length && !forbidden.length && !unwanted, labels: [...labels], missing, forbidden, unwanted, appraisalCount: parsed.appraisals?.length ?? 0, privateHistoryUsed: false, persistedMemory: false, humanQualityVerified: false };
}
//# sourceMappingURL=affect-evaluation.js.map