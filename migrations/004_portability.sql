-- Portable identity and three-way transfer metadata. Local device identity stays in local.* settings.
CREATE TABLE IF NOT EXISTS identity_links (
  namespace TEXT NOT NULL,
  external_key TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(namespace, external_key)
);

CREATE TABLE IF NOT EXISTS owner_channels (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  address TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portable_checkpoints (
  id TEXT PRIMARY KEY,
  inventory_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portable_imports (
  package_id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  imported_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portable_conflicts (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  local_json TEXT,
  incoming_json TEXT,
  base_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at_ms INTEGER NOT NULL
);
