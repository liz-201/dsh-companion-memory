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
export declare function toHalfWidth(input: string): string;
export declare function normalizeText(input: string): string;
export interface TokenizeResult {
    tokens: string[];
    /** true 表示走的是 unicode61 退化路径（无 Segmenter）。 */
    degraded: boolean;
}
export declare function tokenize(input: string): TokenizeResult;
/**
 * 从自然语言里提取「强实体」：日期、时间、端口、版本、英文词、连续数字。
 * 强实体在检索排名里加权，因为它们比虚词更能定位一条记忆。
 */
export declare function strongEntities(input: string): string[];
/**
 * 生成 FTS5 MATCH 表达式。每个 token 用双引号包住并转义内部引号，
 * 词之间默认 AND；调用方可传 'or' 做宽松匹配。
 */
export declare function tokensToMatchQuery(tokens: readonly string[], operator?: 'and' | 'or'): string;
/** LIKE 退化路径同样需要转义 % 与 _，否则用户输入会变成通配符。 */
export declare function escapeLike(input: string): string;
