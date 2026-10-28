# 本夜额度耗尽后的收尾

`scripts/night-closeout.mjs` 仅用于用户明确授权的一次夜间工作。它读取现有 Codex 登录的官方 `account/rateLimits/read`，不读取、复制或更换登录凭据，不购买额度或消耗重置机会。只有 `codex` 的 **300 分钟窗口已用至少 100%，且重置时间尚未到达**才触发；周额度、其他模型桶、网络异常、超时和读不到额度都不算触发。[官方接口与字段](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

默认及 `--check-once` 都是只读预演：不写停止标记，不通知 DSH，不同步、不推送、不关机。必须显式 `--execute`，并有本次未过期的授权文件，才执行监测和收尾。进程通过普通前台 `exec` 启动和跟踪，不安装服务或计划任务。宿主/进程退出后不保证继续运行。

## 本机私有协议

控制文件放在仓库外的本机私有目录，例如 `C:/Users/33544/.dsh/codex-bridge/night-20261029`。下列 `runId`、路径与时间为结构示例；根协调者必须按**本次用户授权**填入实际值。文件写入建议先写临时文件再原子替换。它们不是发到 GitHub 或网盘的配置。

`authorization.json`：

```json
{
  "version": 1,
  "runId": "night-20261029",
  "cwd": "D:/dsh-plugins/integration/companion-memory-20261028",
  "sessionIds": ["session-48b4abe9-ab62-42e9-86ab-60bb62eccfea"],
  "authorizedAtMs": 0,
  "expiresAtMs": 0,
  "allowShutdown": true
}
```

时间填实际毫秒时间戳，`expiresAtMs` 最多在授权后 12 小时；已过期不执行。`sessionIds` 包含本夜所有参与编辑的 DSH 会话。撤销时将 `allowShutdown` 置为 `false`，或写入 `cancel-closeout.json`：`{"runId":"night-20261029"}`。进程每轮及最后 60 秒内每秒检查，撤销后不再执行后续步骤。

确认额度耗尽后，进程创建 `stop-admission.json`，包含本夜 `runId`、实际 `triggeredAtMs` 和限额窗口证据，并以稳定请求 ID 通知对应 DSH 会话。**停止标记是协作协议，不会神奇阻止不遵守协议的编辑者。** 根协调者、DSH 及所属工作线程必须先停止接新任务，完成在途写入和验证，再签收。不会强杀编辑器、DSH 或不相关进程，也不会自动处理其他夜晚的收件箱。

`reviewed-commit.json` 由根协调者或获得本夜授权的 DSH 协调者写入：

```json
{
  "version": 1,
  "runId": "night-20261029",
  "cwd": "D:/dsh-plugins/integration/companion-memory-20261028",
  "commit": "填写已审查验证的40位提交SHA",
  "reviewedAtMs": 0,
  "tests": {
    "exitCode": 0,
    "commands": ["node scripts/build.mjs", "node --test tests/**/*.test.mjs"],
    "evidence": [{"path":"artifacts/night-20261029/full-tests.tap","sha256":"填写证据文件的64位SHA256"}]
  }
}
```

命令只记录实际执行过的验证，不会将这些字符串当作 shell 命令执行。证据文件必须位于工作树内，真实路径解析后仍须在树内；内容 SHA256 必须一致。清单是协调者的显式签收，脚本不能自行判定未知草稿已完成审查。

在收到停止标记并完成所有参与者的在途任务后，再写 `tasks-complete.json`：

```json
{
  "version": 1,
  "runId": "night-20261029",
  "commit": "与reviewed-commit一致的40位SHA",
  "completedAtMs": 0,
  "allTasksStopped": true
}
```

完成时间必须**晚于**该停止标记的 `triggeredAtMs`，不能预先代签。签收最长等待 30 分钟，仍未满足则停止并通知 DSH，保留日志。测试证据、HEAD、干净工作树、全部指定 DSH 会话 `running=false` 及空 inbox 会在收尾各关键阶段再次检查；不会提交任何 WIP。

## 顺序及成功依据

1. 导出本地完整记忆，必须返回 `upload: queued`，确保自动上传确实开启。
2. 调用受保护的 DSH 同步 API，等待 `busy=false`、`ready=true`、无错误且 `lastSyncAtMs` 不早于本次导出。令牌与 Cookie 只在内存中使用。云端依据是现有 `MemoryTransfer.runSync` 的上传元数据、下载 SHA256 校验以及已校验快照的指纹复用；工具不另行重复读取凭据或独立下载网盘正文。
3. Git 目标必须仍是 `liz-201/dsh-companion-memory` 的 `origin/main`。先 fetch，再证明远端是已签收 commit 的祖先，仅推送该 commit，不使用 force，不自动创建提交，最后通过 `ls-remote` 核对远端 SHA。
4. 等待可取消的 60 秒，重新核对授权、签收和工作树，再补一次记忆同步，接住推送／等待期间完成的整理或对端更新；最后核对会话状态和远端，再执行 `shutdown.exe /s /t 0`，不加 `/f`。**不能改成 `/t 60`**：Windows 的非零 `/t` 会隐含 `/f`，可能丢失未保存内容。[微软命令说明](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)

同步或 Git 任一步失败都不关机；状态只记录稳定错误码，不写原始服务响应、凭据或对话。`shutdown-requested` 仅表示 Windows 接受了非强制关机请求，不是主机已关机的独立证明；应用仍可能阻止关机。重复运行同一已请求关机的夜晚不会再次请求。命令发出前先记录 `shutdown-requesting`；若结果丢失或失败，重新运行会报告结果未知并停止，不盲目再次发出系统请求。

## 运行

先安装本次代码、配置上述私有协议文件，并在同一终端设置现有可用代理（如需要），不要在命令行放凭据。

```powershell
node scripts/night-closeout.mjs --run-id night-20261029 --cwd D:/dsh-plugins/integration/companion-memory-20261028 --state-dir C:/Users/33544/.dsh/codex-bridge/night-20261029 --check-once --codex <现有codex可执行文件绝对路径>

node scripts/night-closeout.mjs --run-id night-20261029 --cwd D:/dsh-plugins/integration/companion-memory-20261028 --state-dir C:/Users/33544/.dsh/codex-bridge/night-20261029 --execute --codex <现有codex可执行文件绝对路径> --git-proxy http://127.0.0.1:7897
```

`--poll-ms` 在 1,000–60,000 毫秒之间，默认 60,000。`--git-proxy` 可省略，仅接受无凭据的本机 HTTP 代理，不改全局 Git 配置。执行模式使用 `closeout.lock` 防止同一控制目录并发运行；异常退出遗留锁时须核对其中 PID 已停止再处理，不能绕过仍在运行的收尾进程。

隔离验证：`node --test tests/integration/night-closeout.test.mjs`。测试仅使用 mock API、mock 命令及临时证据文件，不进行真实同步、推送或关机。
