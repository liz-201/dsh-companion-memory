# 第三轮缺陷复核与修复

对应协作消息 `dsh-review-round3-20261026`。三条均确认，并在工作区完成修复；未重启宿主、未访问生产数据库或真实凭据、未提交或 push，不能据此声称生产已生效。

## 修复内容

1. **技术消息学习长期偏好**：新增 `src/memory/source-policy.ts`，只接受 `role=user`、未删除且来源为 `dsh` / `desktop` / `qq` 的消息。`habit-learning.ts` 的显式学习、隐式候选和已有习惯读取均应用来源限制；`local-integration.ts` 的抽取处理、`turn-coordinator.ts` 的观察及 evt 应用、`consolidator.ts` 的选料及应用复核同样限制来源。`codex-bridge`、未知来源和机器角色可保留原文，但不能通过这些入口产生长期事实或情感事件。没有扫描或清洗生产库；历史污染数量未知。
2. **旧备份复活删除数据**：`offline-cli.ts` 接入新增的 `storage/restore.ts`。在独立副本验证备份，合入覆盖前库的 tombstone，并按 principal 校验身份；调用 `deletion.ts` 的重放，清理原文和派生数据、撤销 appraisal / affect event、直接重建受影响快照和 FTS，成功后才另存当前库并替换目标。任务和全量删除选择器也会重放。删除重放必须传入配置，不再写无人消费的 `local.affect-rebuild` 标志。`database.ts` 还修复了无效 SQLite 文件导致构造失败时泄漏连接的问题。新增实际命令入口 `scripts/companionctl.mjs`，更新 `ROLLBACK.md` 的操作说明。
3. **尚未发出就触发未回复暂停**：`repositories.ts` 的 `unresolvedOutbox()` 仅统计 `sent` / `unknown`。原有按 principal 跨会话统计保留；`pending` / `sending` 仍计入日限额与发送队列控制。

`scripts/replay.mjs` 和 `scripts/replay-proactive.mjs` 改用真实 QQ 人类入站所用的 `sourceKind='qq'` 模拟消息；测试用的 `replay` 来源没有加入生产白名单。

## 验证证据

- 工作区 `node scripts/build.mjs --check-only`：通过。
- 隔离发布快照：以 `HEAD=c27204d` 为基线叠加本轮修复，排除未交接的驱力草稿和未提交的 cloud 工作；独立 TypeScript 编译通过。
- 隔离快照 `node --test "tests/**/*.test.mjs"`：**336/336 通过，0 失败，0 跳过**。本地已有的只读提取桌面运行时代码也放入快照，覆盖 5 项原生接口测试；没有操作运行中的桌面端。
- 新增 `tests/integration/review-round3.test.mjs` 共 6 项：机器来源隔离及旧习惯读取、恢复抽取任务与巩固应用复查、未回复闸门、子进程实际 CLI 连续两次恢复、无效备份与不同 owner 拒绝、删除重放的 principal 边界。
- 10,000 轮确定性回放：exit 0，`failureCount=0`，发送 10,000 条，长期记忆实际写入。报告位于 `artifacts/review-round3/release/artifacts/replay-2026-10-26T00-09-37-711Z.json`。首次回放因旧测试来源 `replay` 被新策略拒绝而失败；修正模拟渠道后重新跑满，未放宽生产策略。
- 14 天主动回放：1008 次扫描，生成并发送 13 条，空候选模型调用 0，安静时段违规 0，未知发送结果不重试；此为假模型回放，不验证内容质量。
- 仅回填本轮 10 个源模块对应的 30 个 `lib` 文件。回填后根目录新增回归 **6/6 通过**；未生成驱力模块或覆盖 cloud 构建结果。

本地隔离日志：`artifacts/review-round3/all-tests.log`；搭建快照的临时脚本：`artifacts/review-round3/verify.mjs`。这些属于忽略的验证产物。

## 尚未验证及边界

没有走重载后的真实桌面完整回合，也没有统计真实污染数量。DSH 持有的驱力文件和 cloud 未提交改动保留原样，本轮结果不代表它们通过发布验收。

恢复只能重放当前库和备份中仍存在的删除记录。若当前库已丢失且旧备份没有后来的 tombstone，就无法仅从该备份知道后来删除了什么。不同或未知 owner、冲突身份、无效备份均拒绝恢复，不强行合并。
