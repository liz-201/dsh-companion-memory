# 开发版验证记录

2026-10-24，0.3.0-dev.1。这里的模型均为脚本模型；无真实模型质量结论，无真人评分。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 初始构建/测试 | 92通过、0失败、0跳过 | BASELINE_REPORT.md；artifacts/v03-baseline-tests.log |
| 本次全量测试 | 115通过、0失败、0跳过 | artifacts/v03-regression-tests.log（后续新增测试以最新日志为准） |
| 实际宿主模块 | Session主动提交、幂等、入站复核；LlmRuntime发送前拦截、后台隔离、卸载 | tests/integration/desktop-v03-protocol.test.mjs；HOST_CAPABILITIES.md |
| 一万轮回放 | 一万轮、一万次前台调用、一万条发送；另10次修复调用；无失败 | artifacts/v03-replay-final.log；对应replay JSON含foregroundCalls/repairCalls/failureCount |
| 主动行为模拟 | 14天，1008次扫描，13次生成/尝试投递；空候选调用0，静默违规0，unknown不重试 | artifacts/v03-proactive-replay.json |
| 表达本地性能 | 1000轮，p95约0.40ms；包含接触统计、计划、习惯/历史、lint和审计 | artifacts/v03-expression-benchmark.json |
| 普通检索/装配 | 1000轮，检索p95约4.06ms，装配p95约3.93ms | artifacts/v03-benchmark.log |
| 合成评测管线 | 240用例（开发60/验收180），24段×12轮；完整版实际协调器fake跑60条，旧版/仅提示各2条冒烟；盲评工具拒绝fake输入 | tests/fixtures/v03；artifacts/v03-expression-evaluation.json；v03-baseline-eval-smoke.json；v03-prompt-eval-smoke.json |

`sent=13`包含一次unknown送达，不能把它说成确认到达13条。所有性能数字限本机、当前规模、无真实网络/模型。fake输出只验证生成/检查/写报告流程，不参与自然度、保真率或人类偏好评分。

未测：真实桌面气泡和刷新、完整两机迁移、真实模型对比/消融、三人盲评、7天试用。不得将这些未测项标为通过；不得把合成语料直接称为经过人工审核的锁定评测集。
