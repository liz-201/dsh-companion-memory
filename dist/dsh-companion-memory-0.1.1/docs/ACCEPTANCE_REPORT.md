# 验收报告

> 历史记录：以下为 0.1.0 的原报告。它未覆盖本轮发现的问题，不能证明任务书全部达标。0.1.1 的构建、69 项测试、增强长回放与 QQ 补丁副本结果见 [OPTIMIZATION_REPORT.md](OPTIMIZATION_REPORT.md)。

生成时间：2026-10-23 · 对应版本 `dsh-companion-memory@0.1.0`
证据目录：`artifacts/test-results/`、`artifacts/benchmarks/`、`artifacts/replay-*.json`

## 实际环境

| 项 | 值 |
| --- | --- |
| OS | Windows（win32 x64） |
| DSH Desktop | 0.2.1-rc.2（安装目录 `Z:\dsh\`） |
| Node（宿主内置） | 24.21.0（`ELECTRON_RUN_AS_NODE=1`） |
| SQLite | `node:sqlite` 内置，FTS5 可用 |
| TypeScript | 5.9.3（仓库内 vendored，`_vendor/typescript`） |

## 项目与安装路径

- 源码/构建：`Z:\deepseekharness\fiels\dsh-companion-memory`
- 编译产物：同目录 `lib/`（108 个文件）
- profile：`C:\Users\29400\.dsh\profiles\desktop`
- 安装方式：profile `package.json` 依赖 `link:Z:/deepseekharness/fiels/dsh-companion-memory` + `dsh.profile.bundles` 加一项

## 插件包版本

`dsh-companion-memory@0.1.0`（`private: true`，`main: src/index.js`，bundle patch `./cordis.patch.yml`）

## QQ 补丁与版本

**未修改宿主与 QQ 插件**。插件通过可选服务 `companionMemory` 与桥对接，桥侧为
`dsh-onebot-qq@0.9.3`（profile 已装）。因此本项没有 patch 文件，也不需要 patch 版本号；
对应规格 §13.2 的「最小补丁」要求由服务接口 + 桥侧调用替代实现（见 `docs/COMPATIBILITY.md`）。

## 数据和备份位置

- 数据库：`%USERPROFILE%\.dsh\companions\blue-fish-main.sqlite3`
- 备份：同目录 `backups/`（每日一次，默认保留 7 天，`storage.backupRetentionDays`）
- 测试/回放/基准全部用 `tmpdir()` 下的临时库，**不碰真实数据**

## 人格与作用域

`preset = irritable`（可切 balanced / gentle），`scope = owner_private`
（只对 `channel.ownerChats` 白名单内的私聊会话生效；群聊需显式加 `enabledGroupChats`）。

## 普通聊天模型、思考模式

沿用宿主 `agentDefaultModel`（本 profile：provider `wanju` / model `deepseek-v4.1-flash`），
插件**不硬编码模型名**；`generation.thinking` 默认 `default`，协议解析不依赖思考内容。

---

## PASS（每项都有可复现命令与产物）

### 1. 构建与类型检查

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'Z:\dsh\DeepSeek Harness.exe' scripts\build.mjs
```

结果：`[build] 编译完成：lib/ 下 108 个文件`。tsconfig 打开 `strict` /
`noUncheckedIndexedAccess` / `noUnusedLocals` / `noUnusedParameters`，零错误。
证据：`artifacts/test-results/build.txt`。

### 2. 单元测试 45/45

```powershell
& 'Z:\dsh\DeepSeek Harness.exe' --test "tests/unit/**/*.test.mjs"
```

`ℹ tests 45 · pass 45 · fail 0`。证据：`artifacts/test-results/unit.txt`。

覆盖分布：

| 文件 | 条数 | 覆盖内容 |
| --- | --- | --- |
| `tests/unit/affect.test.mjs` | 13 | T01 骂报错不扣关系、敌意高置信降关系、低置信只影响心情、幂等去重、角色扮演豁免、非入站消息不结算、道歉修复 episode、日上限、互损语境、衰减投影、状态摘要只出等级词、三档人格单调 |
| `tests/unit/memory.test.mjs` | 4 | 事实写入→幂等→冲突→显式更新→撤回；检索命中/不相关不注入/撤回不返回；删除含原文并留墓碑可回放；键规范化 |
| `tests/unit/protocol.test.mjs` | 16 | 合法/版本/未知类型/越界拒绝、越权字段剔除、超字节、畸形 JSON 明确失败、evt 不进正文、根对象闭合识别、say 转义可逆、流式跨分片、半截 evt、重复 say、无包装文本 |
| `tests/unit/time-parse.test.mjs` | 11 | 东八区偏移、明天八点、今晚十一点、今天八点已过不挪到明天、缺时刻、无法理解明确失败、中文数字、提醒识别与正文抽取、墙钟格式化、夏令时跳变 |

### 3. 集成测试 3/3（真实挂载）

```powershell
& 'Z:\dsh\DeepSeek Harness.exe' --test "tests/integration/**/*.test.mjs"
```

三条：`插件元信息齐全` / `装配 → 入站 → 落库 → 卸载` / `缺 systemPrompt / llm 时降级装配而不是崩溃`。
它用一个最小宿主 ctx 真正调用 `apply()`：注册 section、注册命令、暴露服务、跑一轮入站、
校验 SQLite 里原文与状态真的落盘、最后 dispose 并断言没有残留定时器/监听。
证据：`artifacts/test-results/integration.txt`。

### 4. 10,000 轮回放

```powershell
& 'Z:\dsh\DeepSeek Harness.exe' scripts\replay.mjs --turns 10000
```

| 指标 | 实测 |
| --- | --- |
| 总耗时 | 70.1 s（单进程，脚本化模型，含 SQLite 写入） |
| 发送 | 10,000 条（与轮数一致，无重复发送、无漏发） |
| 状态分布 | `say-only` 4,570 · `completed` 5,430 |
| 解析问题 | `evt-skip:target_not_self` 3,429 · `evt-invalid:not-object` 286 · `text-before-say` 285 · `plain-fallback` 285 |
| 记忆 | 1 条（同一事实重复 2,000 次被去重为 1 条 + 多条证据，符合预期） |
| 原文 | 20,000 条 |
| outbox | 0（无未决主动消息） |
| 失败 | **0** |

回放内置不变量：正文不得含 `<say>/<evt>`；`completed` 必须有正文；每轮必须有预算记录；
发送条数必须等于轮数；记忆必须至少写入一条。任一违反即非零退出。
证据：`artifacts/test-results/replay-10000.txt` 与 `artifacts/replay-<时间戳>.json`。

### 5. 本地基准（无模型调用）

```powershell
& 'Z:\dsh\DeepSeek Harness.exe' scripts\benchmark.mjs --mode local
```

| 项目 | p50 | p95 |
| --- | --- | --- |
| 记忆写入 | 0.107 ms | 0.535 ms |
| 检索 | 4.193 ms | 7.271 ms（目标 < 40 ms） |
| 上下文装配 | 4.213 ms | 7.022 ms |

规模：1,000 轮 / 50 条记忆 / 1,000 条原文，数据库 0.48 MB。
**统计限制**：单机、单线程、样本 1,000、无并发，仅代表本机量级，不能外推容量。
证据：`artifacts/benchmarks/2026-10-23T07-56-14-512Z.json`。

### 6. doctor 自检

```powershell
& 'Z:\dsh\DeepSeek Harness.exe' scripts\doctor.mjs
```

`合计 15 项：失败 0 · 警告 5 · 通过 10`。警告项：数据库尚未创建、完整性检查/迁移版本跳过
（首次运行前）、owner 白名单为空、尚无备份目录。全部为「首次运行状态」，不是缺陷。

### 7. 卸载与热重载

集成测试的第三段断言 dispose 后：定时器停止、section 撤掉、命令注销、服务释放、
数据库句柄关闭（Windows 上文件锁随之释放，测试末尾能删掉临时目录即为证）。

---

## FAIL

无。

## NOT_RUN（明确未做，不算通过）

| 项 | 原因 |
| --- | --- |
| `bench:live --mode smoke` | 需要真实模型端点凭据（`DSH_BENCH_LIVE_*` 环境变量），本机未提供；脚本会如实输出 `NOT_RUN` 并写报告，不伪造数字 |
| 真实 QQ 收发联调 | 需要 OneBot 协议端在线 + 真实 QQ 账号；本机未做，**因此不宣称 QQ 链路已通过** |
| 真实模型下的性格体验 | 主观项，需用户按 `docs/USER_REVIEW.md` 自行评价，不由施工方宣布合格 |
| 宿主崩溃/断电恢复 | 未构造断电场景；outbox 的 `unknown` 恢复逻辑仅有单测与代码路径，无现场证据 |
| 群聊多用户隔离 | 代码支持 `enabledGroupChats`，未做多人群实测 |

## BLOCKED

无。

## USER_REVIEW

入口：`docs/USER_REVIEW.md`（15 分钟流程：5 条命令 + 4 个记忆观察点 + 2 个情绪边界 + 1 个协议检查）。

## 真实模型调用数与 usage

**0 次**。本次全部测试与回放使用脚本化模型（`callModel` 注入），不消耗真实 token，
也没有真实 `usage` 数据可报。`TokenLedger` 已按接口记录 `inputTokens/outputTokens/cacheHit/cacheMiss`，
接上真实模型后 `/fish status` 与 `TokenLedger.summary()` 会给出真实数字。

## 真实 QQ 联调收件范围与条数

**0 条**。未连接真实协议端，未发送任何真实 QQ 消息。主动消息链路只在 outbox 层验证
（`pending → sending → sent/failed/unknown` 状态机与幂等键有单测覆盖）。

## p50/p95、样本数与统计限制

见「PASS 5」。另需说明：

- 检索 p95 7.271 ms 是**本机 1,000 轮**的结果，与「40 ms 目标」同量纲但样本小；
- 未测并发多会话、未测 10 万条记忆规模下的退化；
- 回放 70.1 s / 10,000 轮 ≈ 7.0 ms/轮，其中包含 SQLite 同步写，**不含**模型延迟。

## 10,000 轮回放结果

见「PASS 4」：10,000 轮、0 失败、10,000 次发送、记忆去重正确、预算每轮都有记录。
回放同时验证了「完整输入仍有界」：每轮 `measureAndFit` 都会产出预算报告，
超限时按优先级裁剪（人设 → 边界 → 状态 → 记忆 → 近期对话），测试断言每轮 `budget` 非空。

## 长期记忆各组测试结果

| 组 | 结果 | 证据 |
| --- | --- | --- |
| 写入/幂等/冲突/撤回 | 通过 | `memory.test.mjs` 第 1 条（5 个阶段串行断言） |
| 检索命中与负例 | 通过 | `memory.test.mjs` 第 2 条（命中、不相关不注入、撤回不返回） |
| 删除与墓碑回放 | 通过 | `memory.test.mjs` 第 3 条 + `deletion.ts` 的 `replayTombstones` |
| 键规范化（空白/大小写） | 通过 | `memory.test.mjs` 第 4 条 |
| 中文同义改写检索 | 部分通过 | `lexical-index` 的别名组有单测级覆盖；**未做大规模分组评估**，列为 NOT_RUN |
| 10,000 轮后的记忆规模 | 通过 | 回放中 2,000 次重复写入被去重为 1 条，未膨胀 |

## 回滚命令

```powershell
# 只停用（数据保留）
# profile 的 cordis.patch.yml 顶层加：
#   - id: dsh-companion-memory
#     name: dsh-companion-memory
#     disabled: true

# 摘掉代码：profile package.json 里删除依赖与 bundles 条目，重启桌面端
# 数据备份（卸载前）
Copy-Item "$env:USERPROFILE\.dsh\companions\blue-fish-main.sqlite3" "$env:USERPROFILE\Desktop\companion-backup.sqlite3"
```

完整步骤与恢复见 `docs/ROLLBACK.md`。
