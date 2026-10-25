# 2026-10-24 复测报告修复

本次按报告逐项核对源码，修复代码缺陷；保留 profile 中 QQ 和主动消息的启停选择。重建后的 `lib/` 可供现有 link 安装使用，需重启 DSH 才加载新代码。没有修改线上数据库或 profile。

| 报告项 | 实际处理 |
| --- | --- |
| 1 抽取失败 | 双端明确输出契约与合法 m 样例；要求单个完整 evt，缺失与格式错误分别诊断，保留输出前 500 字；重试携带上次错误；按宿主消息结构补齐 id/source，不传 sessionId。首次加载新版会将有未删除用户来源的旧 failed extract 重排一次，此后不反复重排。 |
| 2 推理污染 | 过滤 reasoning/thinking/tool 块和 analysis 通道；剥除助手文本中 thinking/think/reasoning 标签，支持嵌套、跨文本块和未闭合标签；空正文不入库。用户原文保留。不靠语言或关键词猜测无标记的英文是否属于推理，不自动删除旧历史。 |
| 3 情绪冻结 | 最终失败时启用少量整句规则，识别明确感谢、道歉、安抚和直接辱骂；拒绝引用、假设、技术任务与否定。强度低，辱骂不跨过长期恶意置信门槛；不臆造长期事实。中性观察推进快照时间与消息序号，不虚增关系事件。doctor 对有新消息且超过 6 小时未推进的快照提示。 |
| 4 溯源 | 所有可解析评价落 appraisals，affect_events 关联其 id。producer 区分 live_tail / background_observer / local_rule，后台评价的 source 为 background，记忆 source_kind 按路径记录。 |
| 5 桌面 turns 与 QQ | 桌面观察创建轻量 observe 轮次，say_status=not_generated；抽取每次调用的实际用量记账并审计，未知 token 保留 unknown。桌面前台正文由宿主生成，其成本仍由宿主管理。QQ 需用户已有 OneBot 服务启动，插件不自行开启端口。 |
| 6 压缩与备份 | consolidate 和 backup 原本已有 handler，问题是阈值与首次执行时机。整理默认阈值降至 8；显式配置优先。备份在启动及每小时检查时入队，每 UTC 日期一次，走既有一致性备份与保留清理。删除未使用的 prune / proactive-scan 任务类型；清理已由 backup handler 完成，主动扫描由独立调度器完成。 |
| 7 习惯学习 | 识别指向助手回复长度的口语抱怨，包括报告中的“小作文”句式；拒绝引用、一次性要求和写作任务。连续三条短用户消息只产生 proposed 候选，按会话隔离，不自动生效。 |
| 8 主动消息 | 保留 proactive.enabled=false；doctor 明确展示关闭状态。安装示例也明确关闭，代码默认仍为 true，不冒充配置默认值。 |
| 9 doctor | 自动读取 desktop cordis.patch.yml，支持 --config JSON/YAML；修正 memory_fts、sqlite3/db 后缀和 pending/leased 状态；使用随脚本分发的 js-yaml 及许可证，不要求额外 npm 安装。 |
| 10 指标 | 每日累计计数存于 plugin_settings 的 metrics.daily:<UTC日期>:<指标>，重建 Metrics 后可恢复当日值；降级原因逐次写 audit_events(kind=runtime-degraded)，抽取调用用量写 model-usage。耗时分位数仍是当前进程的有界样本。 |

直接只读检查当前安装的 `D:\dsh\resources\app.asar` 中 `dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`：调用链是 `llm.stream → waterfall(llm/stream) → adapterStream`，该层没有自动装配 profile 人设，也未声明 responseFormat/response_format。原报告将“人设覆盖”标为已确认，证据不足；本次不将其作为已确认根因，也不假设宿主支持未声明的 JSON mode。其他中间件与真实模型稳定性仍需重启后复测。

## 验证

```powershell
node scripts/build.mjs
node --test "tests/**/*.test.mjs"
node scripts/doctor.mjs --json
# 其他 profile 或独立插件配置：
node scripts/doctor.mjs --config 'C:\path\cordis.patch.yml' --json
```

`tests/integration/retest-repairs.test.mjs` 使用临时数据库、模拟模型和固定业务时钟，覆盖重试纠错、最终失败保留诊断、保守降级、评价关联、用量、推理过滤、删除竞态、观察进度、启动备份去重、持久计数、口语习惯和真实 YAML doctor。现有宿主加载器测试继续验证整理与人设隔离。

重启后检查 failed extract 是否减少、新任务能否 done，以及 memories/appraisals/turns 是否新增。若模型仍输出聊天正文，last_error 和 runtime-degraded 审计会保留证据；本地降级只保障有限情绪响应，不宣称长期事实抽取成功。

本次验证结果：构建通过，全量 128 项测试通过、0 失败、0 跳过。真实 desktop profile 的只读 doctor 为 0 fail / 2 warn；两个告警来自当前旧进程遗留的抽取终止任务与陈旧快照，需要重启后观察新版恢复结果。诊断产物位于 `artifacts/doctor-retest-20261025.json`，测试日志为 `artifacts/retest-all.log`。
