-- 人设正文与设备台账：把「我是谁」「我在哪台电脑上、用过哪些工作区」变成可迁移数据。
-- 人设属于身份数据，不进 FTS 索引，也不参与记忆检索或墓碑删除。
CREATE TABLE IF NOT EXISTS persona_documents (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  display_name TEXT,
  self_reference TEXT,
  owner_address TEXT,
  nickname_pool_json TEXT,
  prompt_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS persona_documents_owner ON persona_documents(companion_id, enabled);

-- 只记路径、计数与时间；不记文件内容，也不记对话。
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  os_version TEXT,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS device_workspaces (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  label TEXT,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (device_id, cwd)
);
CREATE INDEX IF NOT EXISTS device_workspaces_last ON device_workspaces(device_id, last_seen_ms);
