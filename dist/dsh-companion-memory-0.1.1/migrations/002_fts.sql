-- 002_fts.sql —— 中文友好的关键词索引（任务书 §5.2）。
--
-- FTS5 的 unicode61 能把中文切成单字，但不会切词；真正的分词在写入前由
-- lexical-index.ts 用 Intl.Segmenter(zh) 完成，把「词 + 单字 + 别名 + 原串」
-- 一起写进 lexical_terms，查询侧也走同一套分词，保证「端口号」「版本号」
-- 「昵称」这类词能命中。
--
-- 这张表是派生索引：任何一条记录都必须能由 memories 重新生成，
-- 删除/撤回/替换时同步维护（repositories + deletion.ts）。

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  principal_id UNINDEXED,
  lexical_terms,
  aliases,
  tokenize='unicode61 remove_diacritics 2'
);
