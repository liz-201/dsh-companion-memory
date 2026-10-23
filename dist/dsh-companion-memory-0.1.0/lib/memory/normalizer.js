/**
 * 中文分词与词项归一（任务书 §3.3 / §10.3）。
 *
 * 实测：宿主 Node 24 的 Intl.Segmenter 支持 zh（ICU 完整），因此不引第三方
 * 分词包。策略：
 *   1. Intl.Segmenter(zh) 抽出「词」；
 *   2. 再补单字（中文逐字命中很重要：用户可能只给「饿」「钱」）；
 *   3. 保留数字/英文/版本号/端口号原始 token（22.13.0、3000、DSH）；
 *   4. 归一：全角转半角、小写、去标点。
 *
 * FTS 查询必须由 tokensToMatchQuery 生成，不把用户整句直接当 MATCH 语法。
 */
const FULLWIDTH_OFFSET = 0xfee0;
export function toHalfWidth(input) {
    let out = '';
    for (const char of input) {
        const code = char.codePointAt(0) ?? 0;
        if (code === 0x3000)
            out += ' ';
        else if (code >= 0xff01 && code <= 0xff5e)
            out += String.fromCodePoint(code - FULLWIDTH_OFFSET);
        else
            out += char;
    }
    return out;
}
export function normalizeText(input) {
    return toHalfWidth(input)
        .toLowerCase()
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/[，。！？、；：""''（）《》【】…—~!?,.;:"'()<>[\]{}/\\|@#$%^&*+=`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
let segmenter;
let segmenterFailed = false;
function getSegmenter() {
    if (segmenter !== undefined || segmenterFailed)
        return segmenter;
    try {
        segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
    }
    catch {
        segmenterFailed = true;
        segmenter = undefined;
    }
    return segmenter;
}
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KEEP_RE = /^[a-z0-9][a-z0-9._:-]*$/i;
export function tokenize(input) {
    const normalized = normalizeText(input);
    if (normalized === '')
        return { tokens: [], degraded: false };
    const seg = getSegmenter();
    const tokens = new Set();
    // 英文/数字整体保留，避免 127.0.0.1 被拆碎。
    for (const raw of normalized.split(' ')) {
        if (raw === '')
            continue;
        if (KEEP_RE.test(raw))
            tokens.add(raw);
    }
    if (seg === undefined) {
        for (const char of normalized.replace(/\s+/g, '')) {
            if (CJK_RE.test(char))
                tokens.add(char);
        }
        return { tokens: [...tokens], degraded: true };
    }
    for (const part of seg.segment(normalized)) {
        const word = part.segment.trim();
        if (word === '')
            continue;
        if (!part.isWordLike)
            continue;
        tokens.add(word);
        // 中文双字以上补单字，保证「加班」「加」「班」都能命中。
        if (CJK_RE.test(word)) {
            for (const char of word)
                if (CJK_RE.test(char))
                    tokens.add(char);
        }
    }
    return { tokens: [...tokens], degraded: false };
}
/**
 * 从自然语言里提取「强实体」：日期、时间、端口、版本、英文词、连续数字。
 * 强实体在检索排名里加权，因为它们比虚词更能定位一条记忆。
 */
export function strongEntities(input) {
    const normalized = toHalfWidth(input);
    const found = new Set();
    const patterns = [
        /\b\d{4}-\d{2}-\d{2}\b/g,
        /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
        /\b\d{2,5}\b/g,
        /\bv?\d+\.\d+(?:\.\d+)*\b/g,
        /\b[A-Za-z][A-Za-z0-9_.-]{1,30}\b/g,
    ];
    for (const pattern of patterns) {
        for (const match of normalized.matchAll(pattern))
            found.add(match[0].toLowerCase());
    }
    return [...found];
}
/**
 * 生成 FTS5 MATCH 表达式。每个 token 用双引号包住并转义内部引号，
 * 词之间默认 AND；调用方可传 'or' 做宽松匹配。
 */
export function tokensToMatchQuery(tokens, operator = 'and') {
    const clean = tokens
        .map((token) => token.trim())
        .filter((token) => token !== '')
        .map((token) => `"${token.replace(/"/g, '""')}"`);
    if (clean.length === 0)
        return '';
    return clean.join(operator === 'and' ? ' AND ' : ' OR ');
}
/** LIKE 退化路径同样需要转义 % 与 _，否则用户输入会变成通配符。 */
export function escapeLike(input) {
    return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}
//# sourceMappingURL=normalizer.js.map