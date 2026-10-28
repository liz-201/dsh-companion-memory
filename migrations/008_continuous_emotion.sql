-- Source messages are the authority. These response rows are a durable, idempotent ledger,
-- independent of the number or arrival time of model appraisals.
CREATE TABLE response_events (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL UNIQUE REFERENCES raw_messages(id) ON DELETE CASCADE,
  event_time_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retracted')),
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX response_principal_time ON response_events(principal_id, event_time_ms, source_message_id);

CREATE TABLE emotion_appraisals (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  evidence_quote TEXT NOT NULL,
  event_time_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retracted')),
  revision INTEGER NOT NULL DEFAULT 1,
  producer TEXT NOT NULL,
  UNIQUE(source_message_id, slot)
);
CREATE INDEX emotion_principal_time ON emotion_appraisals(principal_id, event_time_ms, source_message_id);
CREATE TABLE emotion_appraisal_revisions (
  id TEXT PRIMARY KEY,
  appraisal_id TEXT NOT NULL REFERENCES emotion_appraisals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  status TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
);
-- Local cache generation. It is derived, never transferred or consulted as source evidence.
CREATE TABLE continuous_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
INSERT INTO continuous_meta VALUES(1,0);
CREATE TRIGGER continuous_response_insert AFTER INSERT ON response_events BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_response_update AFTER UPDATE ON response_events BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_response_delete AFTER DELETE ON response_events BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_appraisal_insert AFTER INSERT ON emotion_appraisals BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_appraisal_update AFTER UPDATE ON emotion_appraisals BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_appraisal_delete AFTER DELETE ON emotion_appraisals BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;

CREATE TRIGGER response_on_message_insert AFTER INSERT ON raw_messages
WHEN NEW.role = 'user' AND NEW.source_kind IN ('dsh','qq') AND NEW.deleted_at_ms IS NULL
BEGIN
  INSERT OR IGNORE INTO response_events(id,principal_id,conversation_id,source_message_id,event_time_ms)
  SELECT 'response:' || NEW.id, c.principal_id, c.id, NEW.id, NEW.occurred_at_ms
  FROM conversations c WHERE c.id = NEW.conversation_id AND c.kind = 'private';
END;

CREATE TRIGGER response_on_message_change AFTER UPDATE OF content, deleted_at_ms, occurred_at_ms ON raw_messages
BEGIN
  UPDATE response_events SET event_time_ms = NEW.occurred_at_ms,
    status = CASE WHEN NEW.deleted_at_ms IS NULL THEN status ELSE 'retracted' END,
    revision = revision + 1 WHERE source_message_id = NEW.id;
  UPDATE emotion_appraisals SET status = 'retracted', revision = revision + 1
    WHERE source_message_id = NEW.id AND (NEW.deleted_at_ms IS NOT NULL OR NEW.content <> OLD.content);
  UPDATE emotion_appraisals SET event_time_ms=NEW.occurred_at_ms WHERE source_message_id=NEW.id;
  UPDATE emotion_appraisals SET status='retracted',revision=revision+1
    WHERE NEW.deleted_at_ms IS NOT NULL AND (
      json_extract(vector_json,'$.suppliedBehaviorRef')=NEW.id OR
      json_extract(vector_json,'$.suppliedEvidenceRef') IN (SELECT id FROM emotion_appraisals WHERE source_message_id=NEW.id)
    );
  DELETE FROM emotion_appraisals WHERE source_message_id=NEW.id AND NEW.deleted_at_ms IS NOT NULL;
  DELETE FROM plugin_settings WHERE key='emotion.observed:'||NEW.id AND (NEW.deleted_at_ms IS NOT NULL OR NEW.content<>OLD.content);
END;

INSERT OR IGNORE INTO response_events(id,principal_id,conversation_id,source_message_id,event_time_ms)
SELECT 'response:' || r.id,c.principal_id,c.id,r.id,r.occurred_at_ms
FROM raw_messages r JOIN conversations c ON c.id = r.conversation_id
WHERE r.role = 'user' AND r.source_kind IN ('dsh','qq') AND r.deleted_at_ms IS NULL AND c.kind = 'private';
