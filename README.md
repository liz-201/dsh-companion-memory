# dsh-companion-memory

可选：[Codex 与 DSH Desktop 直接协作桥接](docs/CODEX_BRIDGE.md)，通过本机 API 交换开发任务和结果。

> **0.3.0-dev.4 开发版**：新增[一键记忆导入导出与百度网盘同步](docs/CLOUD_MEMORY_SYNC.md)。`/fish files` 打开管理页；连接网盘后，导出自动上传，启动自动检查并合并云端记忆。全量 259 项测试，以及真实百度网盘和 DSH Desktop 重启联动验收均通过，见[验证记录](docs/CLOUD_MEMORY_VALIDATION.md)。[实施进度](docs/roadmap/v0.3/IMPLEMENTATION_PROGRESS.md)和[使用与回退](docs/roadmap/v0.3/DEV_USAGE.md)列明验证界限；真实模型盲评等门槛仍按[原实施任务书](docs/roadmap/v0.3/IMPLEMENTATION_TASKBOOK.md)执行。

> **0.2.0 新增**：普通 DSH 会话默认产生记忆与情感，无需 QQ；可通过文件拷贝或网盘在启动时合并记忆，并识别新旧电脑。普通会话输入 `/fish sync` 获取迁移文件路径。详见 [跨电脑同步说明](docs/SYNC.md)。

> **0.1.1 状态**：已修复情感写入/重放、每日上限、完整请求预算、提前发送与 outbox、提醒开关及作用域；新增隔离 review 和 QQ 桥补丁。当前结果与限制以 [优化验证记录](docs/OPTIMIZATION_REPORT.md) 为准。真实模型与真实 QQ 尚未验收；接入步骤见 [QQ_BRIDGE.md](docs/QQ_BRIDGE.md)。

给 DeepSeek Harness 的**伴侣记忆 + 情绪连续性 + QQ 输出协议**插件：本地 SQLite 是唯一权威，
长期记忆有证据链，情绪状态可衰减可复现，主动消息先落 outbox 再发。

- 可用性：本机已实测挂载（DSH Desktop 0.2.1-rc.2 · Node 24.21.0 · Windows x64）
- 状态：核心功能已接入，开发版持续验证；真实网盘、QQ 收发、模型质量与多日使用按各自验收记录确认
- 数据：`%USERPROFILE%\.dsh\companions\<companion-id>.sqlite3`，卸载插件不删库

## 它做什么

| 能力 | 行为 |
| --- | --- |
| 记忆 | 从对话里抽取事实/偏好/约定/情景，写前查重、冲突保留旧值、每条带原文证据 |
| 检索 | FTS5 + 同义词扩展 + 时间衰减 + 情绪加成，按 token 预算挑选注入 |
| 情绪 | 关系/心情/未消解的冲突按半衰期衰减，事件按权重与日上限结算，可解释 |
| 上下文 | 分层装配（人设/边界/状态/近期对话/记忆/检查点），超预算按优先级裁剪 |
| 输出协议 | `<say>…</say><evt>{…}</evt>`，流式解析、字段白名单、越权字段拒收、失败退化为纯文本 |
| 主动消息 | 候选→打分→生成→outbox→发送回执；静默时段、日上限、未回复即暂停 |
| 命令 | `/fish` 全系列（status/mood/why/memory/remember/forget/correct/personality/proactive/reset/export/doctor） |

## 环境要求

- DSH Desktop：普通会话需要 `session/event` 与 `system-prompt/assemble` 事件；提取情感需要可用的 `llm` 模型。QQ / OneBot 可选，接口说明见 [SYNC.md](docs/SYNC.md)。
- Node ≥ 22.13（用内置 `node:sqlite`，不需要任何原生模块；实测 24.21.0）
- 可选：`dsh-onebot-qq` + OneBot 11 协议端（NapCat / SnowLuma）用于 QQ 收发

## 安装

```powershell
# 1) 构建（会做一次全量类型检查）
cd Z:\deepseekharness\fiels\dsh-companion-memory
& 'Z:\dsh\DeepSeek Harness.exe' scripts\build.mjs

# 2) 自检（只读，不改任何状态）
& 'Z:\dsh\DeepSeek Harness.exe' scripts\doctor.mjs

# 3) 装进 profile：profile 的 package.json 加依赖 + bundles，见 docs/INSTALL.md
```

装好后重启 DSH Desktop，`设置 → 插件` 里应能看到 `dsh-companion-memory`。
详细步骤与配置项见 [docs/INSTALL.md](docs/INSTALL.md)。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-companion-memory
  name: dsh-companion-memory
  config:
    companion: { id: blue-fish-main, name: 大肥鱼, preset: balanced }
    channel:
      ownerChats: ["private:2940015320"]      # 只有这些会话能触发伴侣行为
      enabledGroupChats: []
    proactive: { enabled: false }             # 想让它主动找人再开
```

全部字段与默认值见 `src/config.ts` 的 `DEFAULT_CONFIG`；非法配置会在启动时报 `ConfigError` 并指出字段名。

普通 DSH 会话也会自动整理长期记忆：默认每个角色会话累计 8 条未整理用户消息触发，不依赖 QQ 或 `turns`。升级会补查已有消息；引文允许格式差异并保存真实原文。详见 [本地记忆整理](docs/LOCAL_CONSOLIDATION.md)。

桌面后台抽取有独立的输出契约、纠错重试和终止失败后的保守情绪降级；只采集助手可见正文。观察记录写入 `turns`，评价与情绪事件可以互相追溯。每日备份在启动时入队，按 UTC 日期去重；计数与失败诊断持久化。`doctor` 默认读取 desktop profile，也支持 `--config <JSON/YAML>`。修复范围和复测方法见 [复测修复说明](docs/RETEST_REPAIRS.md)。

默认开启情感驱动的自然表达：熟悉、开心、戒备和生气会影响接话方式；明确的交流偏好作为长期记忆参与表达，不固定套梗，也不播报情感等级。详见 [自然表达](docs/NATURAL_EXPRESSION.md)。

## 命令（QQ 或 Web 会话内）

```
/fish help                 列出全部命令
/fish status               当前状态：绑定、轮次、记忆数、预算占用
/fish mood                 关系/心情等级（可带数字直接校准）
/fish why                  最近一次态度变化的原因与事件 id
/fish memory <关键词>       检索长期记忆（带证据原文）
/fish remember <内容>       手动写入一条记忆
/fish forget <id> --confirm 删除一条记忆（需显式确认）
/fish correct <eventId> <说明>  纠正一次误判
/fish personality balanced 调整当前角色的情感性格（irritable/balanced/gentle）
/fish proactive on|off     开关主动消息
/fish reset relationship --confirm  重置关系值
/fish export               导出记忆 JSON
/fish doctor               跑自检
```

管理类命令不会顺手改关系值；未识别的子命令返回帮助而不是报错。

## 验证

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'Z:\dsh\DeepSeek Harness.exe' --test "tests/**/*.test.mjs"   # 45 单元 + 3 集成
& 'Z:\dsh\DeepSeek Harness.exe' scripts\replay.mjs --turns 10000
& 'Z:\dsh\DeepSeek Harness.exe' scripts\benchmark.mjs
```

本机实测结果见 [docs/ACCEPTANCE_REPORT.md](docs/ACCEPTANCE_REPORT.md)：
回放 10000 轮 0 失败、检索 p95 7.3ms（目标 <40ms）、单元 45/45、集成 3/3。

## 卸载与回滚

禁用插件即可停止全部行为（定时器、监听、后台任务都会随 disposer 释放），数据库保留。
彻底删除与备份恢复见 [docs/ROLLBACK.md](docs/ROLLBACK.md)。

## 文档

- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — 本机环境与构建方式
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — 宿主能力探测与降级矩阵
- [docs/INSTALL.md](docs/INSTALL.md) — 安装、启用、配置
- [docs/ROLLBACK.md](docs/ROLLBACK.md) — 禁用、卸载、备份恢复
- [docs/USER_REVIEW.md](docs/USER_REVIEW.md) — 人工验收怎么走
- [docs/ACCEPTANCE_REPORT.md](docs/ACCEPTANCE_REPORT.md) — 验收报告（含实测数字）
- [docs/IMPLEMENTATION_STATE.md](docs/IMPLEMENTATION_STATE.md) — 各子系统实现/降级/未做状态

## 已知限制

- QQ 真实收发依赖外部 OneBot 协议端，本机未做端到端发送验证（见验收报告「未验证」一节）
- 主动消息需要 profile 里配置 `channel.ownerChats` 且协议端在线，否则只在 outbox 里留痕
- 不做向量检索（`memory.embeddingEnabled` 目前保留字段，未接模型）

MIT License.
