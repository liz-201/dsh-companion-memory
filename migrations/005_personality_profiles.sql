CREATE TABLE personality_profiles (
  revision_id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  persona_id TEXT NOT NULL,
  parent_revision_ids_json TEXT NOT NULL CHECK(json_valid(parent_revision_ids_json)),
  traits_json TEXT NOT NULL CHECK(json_valid(traits_json)),
  templates_json TEXT NOT NULL CHECK(json_valid(templates_json)),
  overrides_json TEXT NOT NULL CHECK(json_valid(overrides_json)),
  seed TEXT,
  generator_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('legacy','owner','mapped','import')),
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX personality_profile_identity ON personality_profiles(companion_id, persona_id);
CREATE TABLE personality_heads (
  companion_id TEXT NOT NULL REFERENCES companions(id),
  persona_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES personality_profiles(revision_id),
  conflict_json TEXT CHECK(conflict_json IS NULL OR json_valid(conflict_json)),
  PRIMARY KEY(companion_id, persona_id)
);
