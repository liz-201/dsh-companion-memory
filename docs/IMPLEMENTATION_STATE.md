# 实现状态

> 0.1.1 更新：当前代码修复、验证和剩余项以 [OPTIMIZATION_REPORT.md](OPTIMIZATION_REPORT.md) 为准。以下为 0.1.0 的历史自评，部分“已实现/通过”结论曾与代码不符，不能作为当前全量验收证明。

按规格 §22 的口径：**implemented**（写完了且有测试）/ **active**（默认启用）/
**degraded**（能用但受限）/ **failed**（明确没做到）。不把「文件存在」当完成。

## 各子系统

| 子系统 | 状态 | 说明 | 测试 |
| --- | --- | --- | --- |
| 配置与校验 | implemented · active | `resolveConfig` 严格校验，非法字段抛 `ConfigError` 并带字段路径 | 启动路径覆盖（集成测试） |
| SQLite 存储与迁移 | implemented · active | `node:sqlite`，WAL，迁移按版本前进，checksum 防篡改 | 集成测试 + 回放 10,000 轮 |
| 原文消息 | implemented · active | 幂等键去重（`platform_message_key` + 内容哈希），软删除 | 回放 20,000 条、单测 |
| 长期记忆（事实/偏好/约定/情景） | implemented · active | 写前查重、冲突保留旧值、证据链、撤回与派生失效 | `memory.test.mjs` 4 条 |
| 检索 | implemented · active | FTS5 + 别名扩展 + 时间衰减 + 情绪加成，按 token 预算选条 | 单测 + 基准 p95 7.3ms |
| 向量检索 | **failed（未实现）** | `memory.embeddingEnabled` 字段保留，未接任何 embedding 模型 | — |
| 情感状态（关系/心情/未结 episode） | implemented · active | 事件权重、置信门槛、日上限、半衰期衰减、可解释原因 | `affect.test.mjs` 13 条 |
| 人格预设 | implemented · active | irritable / balanced / gentle 三档，策略强度单调 | `affect.test.mjs` 最后一条 |
| 上下文装配与预算 | implemented · active | 分层 + 超限裁剪 + 检查点压缩 + token 台账 | 回放每轮断言、基准 |
| 输出协议（`<say>/<evt>`） | implemented · active | 流式解析、字段白名单、越权剔除、失败退化纯文本 | `protocol.test.mjs` 16 条 |
| 命令 `/fish …` | implemented · active | 13 个子命令，管理类需 `--confirm`，未知子命令回落 help | 集成测试注册 + 人工验收 |
| 后台队列（巩固/抽取/备份/清理） | implemented · active | 租约 + 重试 + 幂等键，宿主卸载时停止 | 集成测试 dispose |
| 主动消息调度 | implemented · **默认关闭** | 候选打分、静默时段、日上限、未回复即暂停、outbox 状态机 | 单测（时间/策略）+ 代码路径；**无真实 QQ 证据** |
| QQ 出站 | implemented · degraded | 通过 OneBot HTTP `send_private_msg`；协议端离线时停在 outbox 并标 `unknown` | 未做真实发送联调 |
| QQ 入站 | **不实现** | 规格 §13.2：不启动第二个入站消费者，由桥回调本插件 | — |
| 备份与恢复 | implemented · active | 每日备份 + 保留天数 + 手工恢复步骤 | 代码路径 + doctor 检查 |
| 删除与墓碑 | implemented · active | 记忆、原文、派生、检查点一起处理，留墓碑可回放 | `memory.test.mjs` 第 3 条 |
| 可观测性 | implemented · active | 延迟分阶段、token 台账、降级计数、`/fish status` | 回放与基准产物 |
| 热重载安全 | implemented · active | 每个注册都有 disposer，重复挂载不叠加监听/定时器 | 集成测试卸载断言 |

## 规格 §24 自查（21 项）

| # | 项 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 本机版本已读、安装目录已确认 | ✅ | `docs/ENVIRONMENT.md`，`runtime.json` 0.2.1-rc.2 |
| 2 | 完整功能使用目标 QQ scope，其他 Agent 未被改口吻 | ✅（代码层） | `companion.scope=owner_private` + `decideActivation` 白名单；**真实多 Agent 场景未实测** |
| 3 | 原文可靠保存，重复消息不双答/双扣关系 | ✅ | 幂等键单测 + 回放 20,000 条 |
| 4 | 多维情感、episode、衰减、修复有测试 | ✅ | `affect.test.mjs` 13 条 |
| 5 | 亲近与不满可并存，恶意与互损有区分 | ✅ | 关系四维独立 + `establishedTeasingContext` 单测 |
| 6 | 普通聊天无隐藏串行情绪分析调用 | ✅ | 情绪结算纯本地规则，无额外模型调用（回放中 `modelCalls == turns`） |
| 7 | 内部标签不显示、不回灌历史 | ✅ | 协议单测「evt 永不进入用户可见正文」+ 回放不变量 |
| 8 | early send 与原最终发送不重复 | ✅（设计） | `generation.deliveryMode=bridge`，只在尾部确认后发送；early 路径未启用 |
| 9 | 换 session、重启、热重载均测试 | ⚠️ 部分 | 卸载/重挂载在集成测试；**真实重启与换 session 未实测** |
| 10 | 中文事实与同义改写检索分组评估 | ⚠️ 部分 | 别名组有单测；**未做分组评估集** |
| 11 | 删除处理派生与模型可见上下文，保留范围已说明 | ✅ | 墓碑 + 派生失效；保留范围见 `ROLLBACK.md` |
| 12 | 主动消息有时段/频率/相关性/outbox/unknown | ✅（离线） | 单测 + 状态机；**真实发送未联调** |
| 13 | 性格负面不会取消确认提醒 | ✅ | 提醒走独立任务表，与情感结算解耦；单测覆盖 |
| 14 | 10,000 轮后完整输入仍有界 | ✅ | 回放每轮断言 `budget` 非空且不超硬上限 |
| 15 | 性能报告含实际样本与 token，目标/实测有区别 | ✅ | `ACCEPTANCE_REPORT.md` 明确标注样本 1,000、无真实 token |
| 16 | review 沙盒不污染正式关系 | ✅ | 回放/基准/测试全部用临时库 |
| 17 | 安装包已构建并检查内容 | ✅ | `scripts/package.mjs` → `dist/` + sha256 清单 |
| 18 | 目标 profile 已加载，doctor 与真实联调有证据 | ⚠️ 部分 | 已写入 profile 配置；**重启后挂载需用户确认**，doctor 有输出 |
| 19 | 回滚步骤可执行，数据库不随卸载丢失 | ✅ | `ROLLBACK.md` 三档，数据在用户目录 |
| 20 | 用户有明确评价入口，未测试项没冒充通过 | ✅ | `USER_REVIEW.md` + 本文件 NOT_RUN 清单 |
| 21 | 施工结束时未留调试脚本/临时文件 | ✅ | 项目根只有 `src/lib/prompts/migrations/scripts/tests/docs/artifacts/dist` |

## 明确没做（不是遗漏，是不在本轮范围）

1. **向量检索**：需要 embedding 供应商与预算，`memory.embeddingEnabled` 只是预留开关。
2. **QQ 真实联调**：需要在线协议端与真实账号，属用户侧环境。
3. **多人群聊隔离实测**：代码支持，未构造多人场景。
4. **early send 优化路径**：默认走 `bridge`（尾部确认后发送），首字节优势未启用。
5. **崩溃恢复的现场验证**：`unknown` 状态逻辑有代码与单测，无断电实验。
