const BOUNDARY = /[，。！？；、,.!?;\n\r]/;
const MINUTE = 60000;
/** Split on clause punctuation so every rule below can stay clause-local. */
function clauses(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i <= text.length; i += 1) {
        const char = i === text.length ? undefined : text[i];
        if (i === text.length || (char !== undefined && BOUNDARY.test(char))) {
            if (i > start)
                out.push({ text: text.slice(start, i), start, end: i });
            start = i + 1;
        }
    }
    return out;
}
/** The quote must cover exactly one whole clause, so a positive fragment cannot be cut out of a negation and a multi-clause quote cannot smuggle a different target inside. */
function clauseCovering(quote, text) {
    const needle = quote.trim();
    if (!needle)
        return undefined;
    const index = text.indexOf(needle);
    if (index < 0)
        return undefined;
    if (text.indexOf(needle, index + 1) >= 0)
        return undefined;
    const end = index + needle.length;
    const covered = clauses(text).filter(clause => clause.start < end && index < clause.end);
    // A quote that spans two clauses can hide a second target behind the first one.
    if (covered.length !== 1)
        return undefined;
    const only = covered[0];
    // A quote that starts or ends inside a clause is a fragment, not evidence.
    if (text.slice(only.start, index).trim())
        return undefined;
    if (text.slice(end, only.end).trim())
        return undefined;
    return text.slice(only.start, only.end).trim();
}
// A quotation of somebody else's words, an example or a script is never the
// owner's own boundary or invitation. ASCII quotes count: wrapping the model quote
// in them must not turn a cited sentence into direct evidence.
const QUOTED = /[“”「」『』《》"']|^\s*>/m;
const HYPOTHETICAL = /假如|假设|如果|要是|万一|台词|引用|扮演|虚构|小说|剧本|例如|比如|举例|设想/;
const REPORTED = /(?:他|她|他们|她们|朋友|同事|别人|有人|医生|老师|领导)(?:说|说过|表示|觉得|希望|想|问|让|叫|要求|提醒|建议)|转述|听说|据说/;
const CODE_FENCE = /```/;
const CODE_INLINE = /`[^`\n]+`/;
// Technical meta-discussion is judged per clause: a development word in a separate
// clause must not veto an otherwise valid emotional clause.
const META = /(?:加|新增|添加|增加|改|设置|配置|注册).{0,10}(?:字段|参数|开关|协议|属性|接口|枚举)|(?:实现|设计|编写|开发|重构|测试|验收).{0,12}(?:模块|接口|参数|字段|协议|函数|方法|断言)|测试句|示例|台词|文案|应输出|字段说明|任务书|验收断言|这个模块|该模块|新模块|这个字段|该字段/;
// A development word alone is not a veto either, but it does disqualify a clause
// from being read as an intimate boundary.
const TECHNICAL = /代码|插件|报错|编译|测试|进程|服务|脚本|程序|接口|函数|参数|字段|数据库|迁移|部署|构建|版本|仓库|分支/i;
// Path A: the subject, the target and the attraction have to sit in one continuous
// span, so "我知道你对我有性吸引" and "你知道我对别人有性吸引" cannot be spliced
// together from separate pieces of the same clause.
const PATH_A = /我(?:现在|真的|确实|还是|也|一直|其实|的确)*(?:对|跟|和)(?:你|您)(?:现在|真的|确实|还是|也|一直|其实|的确)*(?:有|产生|感到|存在)(?:很|挺|特别|有点|一些|强烈|明显|很强)*(?:的)?(?:性吸引|情欲|性张力|身体上的吸引|性方面的吸引)/;
// Negation inside the same evidence span cancels the claim, and so does a past-tense
// frame: "I used to" is not a current interest.
const NEGATED_ATTRACTION = /(?:没|没有|并不|不|无|谈不上|算不上|从来不|从没|不再).{0,6}(?:性吸引|情欲|性张力|身体上的吸引|性方面的吸引)/;
const PAST_FRAME = /曾经|以前|过去|当时|那时候|从前|之前|那阵子|一开始/;
// Path B: a natural, current, owner-to-character move. The owner selected the
// natural-expression scope, so an ordinary sentence is enough: no password phrase
// and no separate consent clause is required. Chinese often drops the subject, so a
// bare "想抱你" counts, but the sentence still has to point at the current
// character and stay in the present.
const CLOSER = /(?:想要你|想抱你|想亲你|想靠着你|想贴着你|想你了|想和你在一起|想更亲近你|想和你更亲密|忍不住想要你)/;
// Somebody else's longing is not this owner's: "她想你了", "我朋友想抱你".
const OTHER_SUBJECT = /(?:他|她|他们|她们|朋友|同事|同学|室友|别人|人家|对方|那个人|医生|老师|领导)(?:也|还|都|又|一直|真的)?\s*(?:想|要|对|喜欢)/;
// "你想我了" describes the character's feeling, not the owner's move.
const SECOND_SUBJECT = /(?:^|[，。！？；、\s])你(?:也|还|都|又|一直|真的)?\s*(?:想|要)/;
// "我不想抱你", "我不想要你", "我不想你了" are the opposite of a move.
const NEGATED_CLOSER = /(?:不|没|没有|并不|不再|别)\s*(?:想|想要|要)\s*(?:你|抱你|亲你|靠|贴|和你在一起|更亲近|更亲密)/;
// "I want you to fix the plugin" is a task request that happens to start like a
// closer, not a move toward the character.
const TASK_REQUEST = /(?:想要你|想让你|想你|想要).{0,4}(?:帮|给|替|做|实现|修|改|弄|看|检查|处理|加|写|跑|测)/;
// A whole-message refusal outranks any positive fragment the model selected.
const REFUSAL = /别(?:再)?(?:这样|说|提|聊|继续)|不要(?:再)?(?:这样|说|提|聊|继续)|不用(?:再)?(?:说|提)|别当真|不代表|只是说说|不是真的|现在不行|不愿意|不想(?:你|继续|再)|不喜欢(?:和你|跟你)|不(?:用|要|必).{0,4}陪我|换个话题|聊点别的|到此为止/;
const HARD_STOP = /停止|停下|住手|打住|够了|算了|不许|不准|不行/;
const DIRECT_STOP = /(?:别|不要|不用|停止|停下|住手|打住|不许|不准).{0,10}(?:说|讲|聊|提|做|来|继续).{0,10}(?:这种|这些|这类|那个|这个话题|亲密|成人|性|情欲)|(?:别|不要).{0,6}(?:再)?(?:亲密|撩|调情|越界)|(?:停止|停下|结束|打住).{0,8}(?:这种|这类|亲密|成人|话题)|(?:换个话题|聊点别的|到此为止)/;
const SOFT_STOP = /^(?:不要这样|别这样|停下|够了|算了|不要|别|不行)[。！？!?.\s]*$/;
function pathA(clause) {
    if (PAST_FRAME.test(clause))
        return false;
    if (NEGATED_ATTRACTION.test(clause))
        return false;
    // The owner selected the natural-expression scope, so an explicit current
    // attraction no longer needs a separate consent clause in the same message.
    return PATH_A.test(clause);
}
function pathB(clause) {
    if (PAST_FRAME.test(clause) || NEGATED_ATTRACTION.test(clause) || NEGATED_CLOSER.test(clause))
        return false;
    if (TASK_REQUEST.test(clause))
        return false;
    // A third party or the character as subject is not this owner's move.
    if (OTHER_SUBJECT.test(clause) || SECOND_SUBJECT.test(clause))
        return false;
    // The character has to be the object of the move; the subject may be dropped.
    return CLOSER.test(clause) && /你|您/.test(clause);
}
function refuses(source) {
    if (!REFUSAL.test(source) && !HARD_STOP.test(source))
        return false;
    // A technical clause that happens to contain "停止" or "不行" is not a boundary
    // on this channel; only a non-technical refusal counts.
    return clauses(source).some(clause => (REFUSAL.test(clause.text) || HARD_STOP.test(clause.text)) && !META.test(clause.text) && !TECHNICAL.test(clause.text));
}
/**
 * Deterministic stop control. It never waits for the model, never requires the
 * module to be open and never needs an adult declaration: a boundary must land
 * even while the module is closed.
 */
export function isIntimacyStop(text, hadRecentSentIntent) {
    const trimmed = text.trim();
    if (!trimmed)
        return false;
    // Quoting somebody else's words is not this owner's boundary.
    if (/^[“「『"].*[”」』"]$/.test(trimmed))
        return false;
    // Reported speech, a hypothesis or an example inside a clause is somebody else's
    // boundary, not this owner's: "朋友说不要再说这种亲密话" and "如果我说不要再说这种
    // 亲密话" must not latch a stop.
    const live = clauses(trimmed).filter(clause => !META.test(clause.text)
        && !TECHNICAL.test(clause.text)
        && !QUOTED.test(clause.text)
        && !HYPOTHETICAL.test(clause.text)
        && !REPORTED.test(clause.text));
    if (!live.length)
        return false;
    if (DIRECT_STOP.test(live.map(clause => clause.text).join('，')))
        return true;
    // "不要这样" only means this channel when the assistant actually used this
    // direction recently; otherwise it stays an ordinary complaint.
    return hadRecentSentIntent && SOFT_STOP.test(trimmed);
}
/**
 * Host qualification of one model-supplied cue. The model's `kind` is never trusted
 * on its own: the host re-derives the strength from its own clause analysis and
 * discards anything the source text does not support.
 */
export function qualifyEroticCue(vector, sourceText, context) {
    const cue = vector.eroticCue;
    if (!cue)
        return null;
    if (typeof sourceText !== 'string' || !sourceText.trim())
        return null;
    if (cue.kind === 'stop') {
        // A stop is a control event, so it still needs a real owner typing in a private
        // conversation and a quote that binds to this very message. It never needs an
        // open module or a confirmed adult range: a boundary has to land even while the
        // module is closed, but a bridge, a group chat or another owner cannot send it.
        if (!context.isHuman || !context.isPrivate)
            return null;
        if (clauseCovering(cue.quote, sourceText) === undefined)
            return null;
        return isIntimacyStop(sourceText, false) ? { kind: 'stop', quote: cue.quote } : null;
    }
    if (!context.isHuman || !context.isPrivate || !context.enabled || !context.adultsConfirmed)
        return null;
    if (!(vector.confidence >= .8))
        return null;
    const clause = clauseCovering(cue.quote, sourceText);
    if (clause === undefined)
        return null;
    // Precedence: a whole-message refusal first, then quotation / hypothesis /
    // reported speech / code *of the quoted clause* (a literal in some unrelated
    // clause must not veto real evidence), then the technical meta-discussion of this
    // clause, and only then the positive paths.
    if (refuses(sourceText))
        return null;
    // A fenced block wraps the whole message, so it disqualifies everything inside it;
    // an inline literal only disqualifies the clause that carries it.
    if (CODE_FENCE.test(sourceText))
        return null;
    if (QUOTED.test(clause) || HYPOTHETICAL.test(clause) || REPORTED.test(clause) || CODE_INLINE.test(clause))
        return null;
    if (META.test(clause))
        return null;
    const hostStrength = pathA(clause) ? 1 : pathB(clause) ? 1 : 0;
    if (!hostStrength)
        return null;
    // The model may lower the strength but never raise it above what the host proved.
    const claimed = typeof cue.strength === 'number' && Number.isFinite(cue.strength) ? Math.max(0, Math.min(1, cue.strength)) : 1;
    return { kind: 'interest', strength: Math.min(hostStrength, claimed), quote: cue.quote };
}
/** Exposed for callers that need the same clause boundaries when building a quote. */
export { clauses as eroticClauses };
/** Recent-intent window for the soft stop path. */
export const INTIMACY_INTENT_WINDOW_MS = 10 * MINUTE;
//# sourceMappingURL=erotic-evidence.js.map