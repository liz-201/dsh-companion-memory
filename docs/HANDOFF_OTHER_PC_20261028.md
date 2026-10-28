# 对端交接：情感扩展 + 迁移 008（分支 `codex/other-pc-emotion`）

本分支用于把「本机已有的情感扩展」完整交接给另一台电脑，**不修改 main**。

## 分支

| 项 | 值 |
| --- | --- |
| 远端仓库 | `https://github.com/liz-201/dsh-companion-memory.git` |
| 分支 | `codex/other-pc-emotion` |
| 提交 | `2321eeea0fc6c878d60d7fa2310498305422dee1` |
| 基点 | `0e29d68d4266db56b705f22a9da89f0ed025b0e2`（main 当时的 HEAD） |
| main | 未改动，仍为 `1c3f23e31ab36de4c4cb40cf1b9f0e98198eebe1` |

取回：

```powershell
git fetch origin codex/other-pc-emotion
git switch --track -c other-pc-emotion origin/codex/other-pc-emotion
```

不要把这个分支 merge 进 main 之前先在本机副本验证：它基于旧的 `0e29d68`，与 origin/main 领先的 4 个提交（`770ed7a`、`2f56acb`、`0fd3d36`、`1c3f23e`）有 23 个文件的改动重叠。

## 本分支相对基点新增的内容

`git diff --name-status 0e29d68 2321eee`：修改 87 个、新增 60 个。

新增按目录：`lib/` 33、`src/` 11、`tests/` 5、`scripts/` 4、`docs/roadmap/computer-affect/` 6、`migrations/` 1。

### 迁移

`migrations/008_continuous_emotion.sql`（4794 字节，SHA256 `6a5eb87e50bba2be69e325bfaba16a14c892f16e09a86208cedabd9f835844af`）

建三张表：

- `response_events`：`source_message_id` 唯一，主键 `id`，`status ∈ (active, retracted)`，`revision`
- `emotion_appraisals`：列 `id, principal_id, conversation_id, source_message_id, slot, vector_json, evidence_quote, event_time_ms, status, revision, producer`，`UNIQUE(source_message_id, slot)`
- `emotion_appraisal_revisions`：列 `id, appraisal_id, revision, vector_json, status, recorded_at_ms`

这三张表正是对端包里 schema 8 声明的表，因此本分支才是那份包对应的程序结构。

### 源码（新增 11 个 .ts）

`src/domain/drive-projector.ts`、`src/domain/emotion-appraisal.ts`、`src/domain/occ-classifier.ts`、`src/domain/pad-projector.ts`、`src/panel/continuous-controls.ts`、`src/runtime/emotion-observation.ts`、`src/runtime/extraction-recovery.ts`、`src/runtime/perception-context.ts`、`src/runtime/window-perception.ts`、`src/runtime/window-probe.ts`、`src/storage/continuous-affect.ts`

这些模块不是孤立的：`src/index.ts`、`src/runtime/turn-coordinator.ts`、`src/panel/controller.ts`、`src/panel/page.ts`、`src/storage/portable.ts`、`src/adapters/local-integration.ts`、`src/cloud/memory-transfer.ts`、`src/domain/expression-plan.ts`、`src/expression/runtime.ts`、`src/proactive/frequency.ts` 都有对应接线改动——所以本分支必须整分支取回，不能只挑新增文件。

### 测试（新增 5 个）

`tests/unit/continuous-emotion.test.mjs`、`tests/integration/continuous-affect.test.mjs`、`tests/integration/continuous-portable.test.mjs`、`tests/integration/emotion-evaluation.test.mjs`、`tests/integration/window-perception.test.mjs`

### 脚本（新增 4 个）

`scripts/perception-fixture.ps1`、`scripts/replay-continuous.mjs`、`scripts/test-windows-perception.mjs`、`scripts/windows-perception.ps1`

### 设计文档

`docs/roadmap/computer-affect/`：`ACCEPTANCE.md`、`IMPLEMENTATION_REPORT.md`、`IMPLEMENTATION_TASKBOOK.md`、`README.md`、`RESEARCH.md`、`TECHNICAL_DESIGN.md`

## 本机验证结果（2026-10-28）

- 类型检查：`node scripts/build.mjs --check-only` → 通过，exit 0
- 情感扩展 5 个测试文件：**88 项通过、0 失败**
- 迁移 001–008 在全新内存库上全量应用：`applied: 1,2,3,4,5,6,7,8`，`current: 8 pending: 0 mismatch: 0`，三张情感表建表成功
- 密钥扫描：对本分支全部 blob 扫 `ghp_` / `github_pat_` / `sk-` / `AKIA` / PEM 私钥 → 0 命中
- 本分支不含 `*.sqlite3` / `*.db` / `credentials/` / `.env*`

## 环境注意

- 本机 `PATH` 上的 `node` 是 **v14.21.3**，跑 `--test` 会报 `bad option: --test`。须用 `Z:\nvm\nvm\v26.1.0\node.exe`（或任意 ≥ 22.13）执行构建与测试。
- `git config` 里的 `http.proxy` / `https.proxy` 指向 `http://127.0.0.1:7897`。该代理当前可用；若失效，直连 `https://github.com` 也是通的，用 `git -c http.proxy= -c https.proxy= ...` 绕过。
- 编译依赖 `_vendor/typescript/lib/tsc.js`（随仓库跟踪），不需要联网安装。
