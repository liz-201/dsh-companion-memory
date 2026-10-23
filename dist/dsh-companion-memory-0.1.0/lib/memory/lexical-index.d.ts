/**
 * 词项与别名索引（任务书 §10.3）。
 *
 * 职责：
 *   1. 写入侧：把一条记忆压成可检索的词项串（claim + 主题/谓语/别名）。
 *   2. 读取侧：把用户当轮原话扩展成「同义/别名」查询词，不把整句直接当 MATCH 语法。
 *
 * 别名字典是**数据**不是魔法：内置一小份陪伴场景常用别名（鱼/你/他/它），
 * 其余靠 subject_key/predicate_key 的规范化键与 FTS 命中，不做同义词大词表。
 */
export interface AliasGroup {
    readonly canonical: string;
    readonly aliases: readonly string[];
}
/**
 * 内置别名组。canonical 是入库时的规范词，aliases 是用户可能说的写法。
 * 只覆盖「同一实体不同叫法」，不覆盖近义情绪（那会污染检索）。
 */
export declare const BUILTIN_ALIAS_GROUPS: readonly AliasGroup[];
/** 额外的用户/项目字典：调用方可注入「别名→规范词」，与内置表合并。 */
export type AliasDictionary = ReadonlyMap<string, string>;
/**
 * 写入侧：把一条记忆的可检索文本拼成 FTS 的 lexical_terms。
 * 只保留去重后的词项，长度受限——FTS 行不该无限增长。
 */
export declare function buildLexicalTerms(parts: readonly (string | null | undefined)[]): string;
/** 写入侧：别名串（规范词 + 关联叫法），单独一列存，检索时同样过滤。 */
export declare function buildAliases(subjectKey: string | null, predicateKey: string | null, extra?: readonly string[]): string;
export interface QueryTerms {
    /** 原始 token（已归一），用于 FTS/LIKE。 */
    tokens: string[];
    /** 由别名表扩展出的规范词，权重低于原始 token。 */
    expanded: string[];
    /** 强实体（日期、端口、版本、英文词）——排名加权用。 */
    entities: string[];
    /** 该查询是否是「事实型」：事实型请求不叠加情绪加分（§10.3）。 */
    factual: boolean;
    degraded: boolean;
}
/**
 * 读取侧：把当轮用户原话变成查询词。
 * 注意：这里**不**构造 FTS 语法，只产出词数组；MATCH 表达式由 tokensToMatchQuery 生成。
 */
export declare function buildQueryTerms(input: string, dictionary?: AliasDictionary): QueryTerms;
/**
 * 查询词优先级：原始 token 高于别名扩展词，强实体最高。
 * 返回给 retriever 用的「词 → 权重」表，避免把标题党式长句整句加权。
 */
export declare function termWeights(terms: QueryTerms): Map<string, number>;
