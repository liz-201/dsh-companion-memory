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

import { normalizeText, strongEntities, tokenize } from './normalizer.js'

export interface AliasGroup {
  readonly canonical: string
  readonly aliases: readonly string[]
}

/**
 * 内置别名组。canonical 是入库时的规范词，aliases 是用户可能说的写法。
 * 只覆盖「同一实体不同叫法」，不覆盖近义情绪（那会污染检索）。
 */
export const BUILTIN_ALIAS_GROUPS: readonly AliasGroup[] = [
  { canonical: '鱼', aliases: ['大肥鱼', '蓝鱼', '蓝色大肥鱼', '肥鱼', '胖鱼'] },
  { canonical: '加班', aliases: ['加班到', '又加班', '熬夜', '通宵'] },
  { canonical: '工作', aliases: ['上班', '公司', '单位', '打工'] },
  { canonical: '考试', aliases: ['考研', '期末', '补考', '机考'] },
  { canonical: '睡觉', aliases: ['睡', '困', '失眠', '熬夜睡'] },
  { canonical: '吃', aliases: ['吃饭', '饿', '外卖', '夜宵'] },
  { canonical: '电脑', aliases: ['主机', '笔记本', '机器', '台式'] },
  { canonical: '项目', aliases: ['repo', '仓库', '代码', '工程'] },
]

const ALIAS_INDEX: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const group of BUILTIN_ALIAS_GROUPS) {
    map.set(group.canonical, group.canonical)
    for (const alias of group.aliases) map.set(alias, group.canonical)
  }
  return map
})()

/** 额外的用户/项目字典：调用方可注入「别名→规范词」，与内置表合并。 */
export type AliasDictionary = ReadonlyMap<string, string>

const TOKEN_SEPARATOR = ' '
const MAX_LEXICAL_TERMS = 240

/**
 * 写入侧：把一条记忆的可检索文本拼成 FTS 的 lexical_terms。
 * 只保留去重后的词项，长度受限——FTS 行不该无限增长。
 */
export function buildLexicalTerms(parts: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (part === null || part === undefined || part === '') continue
    const { tokens } = tokenize(part)
    for (const token of tokens) {
      const normalized = token.trim()
      if (normalized === '' || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
      if (out.length >= MAX_LEXICAL_TERMS) return out.join(TOKEN_SEPARATOR)
    }
  }
  return out.join(TOKEN_SEPARATOR)
}

/** 写入侧：别名串（规范词 + 关联叫法），单独一列存，检索时同样过滤。 */
export function buildAliases(subjectKey: string | null, predicateKey: string | null, extra: readonly string[] = []): string {
  const values = new Set<string>()
  for (const key of [subjectKey, predicateKey]) {
    if (key === null || key === '') continue
    for (const piece of key.split(/[.:/|]+/)) {
      const trimmed = normalizeText(piece)
      if (trimmed !== '') values.add(trimmed)
    }
  }
  for (const item of extra) {
    const trimmed = normalizeText(item)
    if (trimmed !== '') values.add(trimmed)
  }
  for (const group of BUILTIN_ALIAS_GROUPS) {
    if (values.has(group.canonical)) for (const alias of group.aliases) values.add(normalizeText(alias))
  }
  return [...values].join(TOKEN_SEPARATOR)
}

export interface QueryTerms {
  /** 原始 token（已归一），用于 FTS/LIKE。 */
  tokens: string[]
  /** 由别名表扩展出的规范词，权重低于原始 token。 */
  expanded: string[]
  /** 强实体（日期、端口、版本、英文词）——排名加权用。 */
  entities: string[]
  /** 该查询是否是「事实型」：事实型请求不叠加情绪加分（§10.3）。 */
  factual: boolean
  degraded: boolean
}

const FACTUAL_MARKERS: readonly RegExp[] = [
  /(什么时候|哪天|多久|多少|几点|在哪|谁|是不是|有没有|还记得|记不记得|上次|以前|之前|那次)/,
  /(deadline|截止|端口|版本|路径|密码|地址|电话|时间)/i,
]

/**
 * 读取侧：把当轮用户原话变成查询词。
 * 注意：这里**不**构造 FTS 语法，只产出词数组；MATCH 表达式由 tokensToMatchQuery 生成。
 */
export function buildQueryTerms(input: string, dictionary?: AliasDictionary): QueryTerms {
  const { tokens, degraded } = tokenize(input)
  const expanded = new Set<string>()
  const lookup = (term: string): void => {
    const fromUser = dictionary?.get(term)
    if (fromUser !== undefined && fromUser !== term) expanded.add(normalizeText(fromUser))
    const canonical = ALIAS_INDEX.get(term)
    if (canonical !== undefined && canonical !== term) expanded.add(canonical)
    // 反向：用户说规范词时，把组内别名也加入（提高召回）。
    if (canonical !== undefined) {
      for (const group of BUILTIN_ALIAS_GROUPS) {
        if (group.canonical !== canonical) continue
        for (const alias of group.aliases) expanded.add(normalizeText(alias))
      }
    }
  }
  for (const token of tokens) lookup(token)
  for (const token of [...expanded]) if (tokens.includes(token)) expanded.delete(token)
  const factual = FACTUAL_MARKERS.some((pattern) => pattern.test(input)) || strongEntities(input).length >= 2
  return {
    tokens,
    expanded: [...expanded],
    entities: strongEntities(input),
    factual,
    degraded,
  }
}

/**
 * 查询词优先级：原始 token 高于别名扩展词，强实体最高。
 * 返回给 retriever 用的「词 → 权重」表，避免把标题党式长句整句加权。
 */
export function termWeights(terms: QueryTerms): Map<string, number> {
  const weights = new Map<string, number>()
  for (const token of terms.tokens) weights.set(token, 1)
  for (const entity of terms.entities) {
    const key = normalizeText(entity)
    weights.set(key, (weights.get(key) ?? 0.5) + 0.6)
  }
  for (const extra of terms.expanded) {
    if (!weights.has(extra)) weights.set(extra, 0.35)
  }
  return weights
}
