CREATE TABLE proactive_opportunities (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  persona_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  kind TEXT NOT NULL,
  source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json)),
  topic_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  not_before_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  expected_inbound_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','selected','sent','expired','cancelled')),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  UNIQUE(principal_id, kind, topic_key)
);
CREATE TABLE proactive_feedback (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  user_message_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('positive','negative','busy','explicit_preference','unrelated','unknown')),
  evidence_quote TEXT,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  rule_version TEXT NOT NULL,
  supersedes_id TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX feedback_principal ON proactive_feedback(principal_id);
CREATE TABLE proactive_ownership (
  companion_id TEXT PRIMARY KEY REFERENCES companions(id),
  active_device_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  parent_revision_ids_json TEXT NOT NULL CHECK(json_valid(parent_revision_ids_json)),
  conflict_json TEXT CHECK(conflict_json IS NULL OR json_valid(conflict_json))
);
CREATE TABLE expression_audits (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  message_id TEXT,
  rule_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  status TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  repair_calls INTEGER NOT NULL,
  latency_ms REAL NOT NULL,
  created_at_ms INTEGER NOT NULL
);
ALTER TABLE outbox ADD COLUMN target_json TEXT;
ALTER TABLE outbox ADD COLUMN opportunity_id TEXT;
ALTER TABLE outbox ADD COLUMN persona_id TEXT;
ALTER TABLE outbox ADD COLUMN origin_device_id TEXT;
