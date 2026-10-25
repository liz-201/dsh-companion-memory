CREATE TABLE episodic_annotations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  episode_id TEXT,
  source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json)),
  appraisal_json TEXT NOT NULL CHECK(json_valid(appraisal_json)),
  interpretation_json TEXT NOT NULL CHECK(json_valid(interpretation_json)),
  supersedes_id TEXT,
  created_at_ms INTEGER NOT NULL,
  rule_version TEXT NOT NULL
);
CREATE TABLE expression_habits (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  status TEXT NOT NULL CHECK(status IN ('proposed','active','revoked')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json)),
  revision_id TEXT NOT NULL,
  supersedes_id TEXT,
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER
);
CREATE INDEX expression_habit_principal ON expression_habits(principal_id, status);
CREATE TABLE memory_lifecycle (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  archive_state TEXT NOT NULL CHECK(archive_state IN ('active','archived')),
  last_retrieved_ms INTEGER,
  tombstone_event_id TEXT
);
