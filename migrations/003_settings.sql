-- 003_settings.sql
-- 插件自身的运行时开关（任务书 §15.1 `proactive on/off` 需要跨重启保持）。
--
-- 为什么不写进配置文件：配置文件属于部署面，模型/命令不应该改写部署文件；
-- 而「今天别主动找我」这类开关是用户即时意图，属于数据面。
-- 这里只放 key/value 小开关，不放任何可派生的业务状态。

CREATE TABLE IF NOT EXISTS plugin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
