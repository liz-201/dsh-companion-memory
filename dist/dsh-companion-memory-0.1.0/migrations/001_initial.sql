-- 001_initial.sql —— 任务书 §5.2 初始 DDL。
--
-- 说明：
-- 1. 与规范草案的差异只有三处，且都是加法，不改变等价行为：
--    a. `PRAGMA foreign_keys` 由连接层设置（database.ts），放在事务里无效；
--    b. 追加了 `memory_fts` 之外的辅助索引，用于 episode/outbox 的到期扫描；
--    c. `memories.object_json` 与 `appraisals.evidence_quote` 保持可空，与其他字段一致。
-- 2. FTS5 虚拟表单独在 002_fts.sql 里建，因为驱动可能不支持 FTS5；不支持时
--    记录 capability 并退化为 LIKE 检索（lexical-index.ts），不静默假装成功。
-- 3. 所有时间字段都是整数毫秒（UTC epoch），时区只存在于 tasks.timezone。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS companions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  personality_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  bot_account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (companion_id, bot_account_id, user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK (kind IN ('private','group')),
  platform_conversation_id TEXT NOT NULL,
  active_session_id TEXT,
  latest_inbound_seq INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (principal_id, kind, platform_conversation_id)
);

CREATE TABLE IF NOT EXISTS raw_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  platform_message_key TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','internal','tool')),
  source_kind TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  delivery_status TEXT,
  deleted_at_ms INTEGER,
  UNIQUE (conversation_id, platform_message_key, role)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  session_id TEXT NOT NULL,
  inbound_message_id TEXT REFERENCES raw_messages(id),
  state_revision_used INTEGER,
  status TEXT NOT NULL,
  say_status TEXT NOT NULL DEFAULT 'not_generated',
  tail_status TEXT NOT NULL DEFAULT 'not_expected',
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS appraisals (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL REFERENCES raw_messages(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  intent TEXT NOT NULL,
  target TEXT NOT NULL,
  severity INTEGER NOT NULL CHECK (severity BETWEEN 0 AND 3),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_quote TEXT,
  producer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','retracted','pending')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (source_message_id, kind, target, revision)
);

CREATE TABLE IF NOT EXISTS relationship_episodes (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','repairing','resolved','archived')),
  source_message_ids_json TEXT NOT NULL,
  applied_deltas_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_event_at_ms INTEGER NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS affect_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  appraisal_id TEXT REFERENCES appraisals(id),
  episode_id TEXT REFERENCES relationship_episodes(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_time_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','retracted')),
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS affect_snapshots (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  revision INTEGER NOT NULL,
  projected_through_seq INTEGER NOT NULL,
  as_of_ms INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  rule_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  conversation_id TEXT REFERENCES conversations(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','group','shared')),
  kind TEXT NOT NULL CHECK (kind IN ('episode','fact','preference','interaction_rule','hypothesis')),
  subject_key TEXT,
  predicate_key TEXT,
  object_json TEXT,
  claim TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','retracted','archived')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  salience REAL NOT NULL CHECK (salience BETWEEN 0 AND 1),
  valid_from_ms INTEGER,
  valid_to_ms INTEGER,
  event_at_ms INTEGER,
  observed_at_ms INTEGER NOT NULL,
  activation_at_ms INTEGER NOT NULL,
  embedding_model_id TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES raw_messages(id),
  quote TEXT NOT NULL,
  PRIMARY KEY (memory_id, message_id)
);

CREATE TABLE IF NOT EXISTS memory_edges (
  from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('supports','contradicts','updates','derived_from')),
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  source_message_id TEXT REFERENCES raw_messages(id),
  kind TEXT NOT NULL CHECK (kind IN ('reminder','open_topic','commitment','repair')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','done','cancelled','expired')),
  due_at_ms INTEGER,
  timezone TEXT NOT NULL,
  expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT REFERENCES turns(id),
  candidate_key TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks(id),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','unknown','cancelled')),
  expected_inbound_seq INTEGER,
  planned_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  platform_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);

CREATE TABLE IF NOT EXISTS topic_checkpoints (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  session_id TEXT NOT NULL,
  current_flag INTEGER NOT NULL DEFAULT 1,
  summary_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_current_topic
ON topic_checkpoints(conversation_id) WHERE current_flag = 1;

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  principal_id TEXT REFERENCES principals(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','leased','done','failed','cancelled')),
  available_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deletion_tombstones (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  selector_json TEXT NOT NULL,
  affected_ids_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT REFERENCES principals(id),
  kind TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_by_conversation_time ON raw_messages(conversation_id, occurred_at_ms);
CREATE INDEX IF NOT EXISTS appraisal_by_source ON appraisals(source_message_id, status);
CREATE INDEX IF NOT EXISTS affect_by_principal_seq ON affect_events(principal_id, seq);
CREATE INDEX IF NOT EXISTS memory_by_scope ON memories(principal_id, visibility, status, kind);
CREATE INDEX IF NOT EXISTS memory_by_fact ON memories(principal_id, subject_key, predicate_key, valid_from_ms);
CREATE INDEX IF NOT EXISTS tasks_by_due ON tasks(status, due_at_ms);
CREATE INDEX IF NOT EXISTS outbox_by_status ON outbox(status, planned_at_ms);
CREATE INDEX IF NOT EXISTS jobs_by_available ON background_jobs(status, available_at_ms);

-- 补充索引（加法）：episode 合并需要按 principal 找最近的 open 冲突。
CREATE INDEX IF NOT EXISTS episode_by_principal_time
ON relationship_episodes(principal_id, status, last_event_at_ms);
-- 补充索引（加法）：清理与删除需要按会话倒序扫原文。
CREATE INDEX IF NOT EXISTS raw_by_conversation_seq ON raw_messages(conversation_id, seq);
