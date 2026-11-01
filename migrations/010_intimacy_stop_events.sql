-- Permission is local. Only append-only stop controls are portable.
-- Source deletion may remove the pointer, never silently reopen the capability.
CREATE TABLE intimacy_stop_events (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES raw_messages(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL,
  origin_device_id TEXT NOT NULL
);
CREATE INDEX intimacy_stop_owner_time ON intimacy_stop_events(principal_id, created_at_ms, id);
