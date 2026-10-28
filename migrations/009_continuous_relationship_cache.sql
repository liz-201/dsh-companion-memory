-- Keep the source-derived cache coherent when legacy relationship events or
-- source classification changes. Applied migration 008 remains unchanged.
CREATE TRIGGER continuous_affect_event_insert AFTER INSERT ON affect_events BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_affect_event_update AFTER UPDATE ON affect_events BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_affect_event_delete AFTER DELETE ON affect_events BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER continuous_source_classification AFTER UPDATE OF source_kind, role, conversation_id ON raw_messages BEGIN UPDATE continuous_meta SET revision=revision+1 WHERE singleton=1; END;
