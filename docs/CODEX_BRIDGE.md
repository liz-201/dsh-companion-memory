# Codex 与 DSH Desktop 直接协作

这是独立可选的 `dsh-codex-bridge` bundle。它从 Desktop 宿主获取已有本地 API 的连接信息，写入用户目录 `~/.dsh/codex-bridge/connection.json`。命令行通过 DSH 原有 `/connect` 鉴权和 `/api/session/*` 接口交换任务，不操作桌面窗口，也不直接调用另一套 DeepSeek API。

连接文件包含本机访问凭据，不要分享或加入版本控制。插件不新增网络监听，仅接受 `http://127.0.0.1:端口`。桌面端重新启动后会刷新连接信息；卸载时清理自己发布的连接文件。当前协议与本机 DSH Desktop 0.2.1-rc.3 核对，升级宿主后需要复核。

连接发布等待 `appReady`，通过当前宿主的 `webServer.getOrigin()` 获取已监听地址，再调用 `connection.authenticatedUrl()`。仅在旧宿主没有该方法时兼容字符串 `origin`；缺失地址不会传入 URL 认证函数。发布错误只报告不含凭据的警告，不中断 Desktop 启动。这修复了 2026-10-25 重启时的 `Invalid URL (input: undefined)` 崩溃。

## 安装与连接

```powershell
node scripts/install-dsh-bridge.mjs          # 准备可审阅的 profile 修改
node scripts/install-dsh-bridge.mjs --apply  # 备份 package.json 并加入独立 bundle
# 重新加载 profile 或重启 DSH Desktop，使新增 bundle 生效
node scripts/dsh-bridge.mjs status
```

安装只添加 `dsh-codex-bridge` 依赖、bundle 和指向本仓库 integration/codex-bridge 的目录链接。不修改 app.asar，不修改伴侣数据库，不更改模型或人设。连接尚未建立时 status 明确失败；测试通过不代表已经连接了真实模型。

## 协作流程

```powershell
node scripts/dsh-bridge.mjs create --cwd D:/dsh-plugins/dsh-companion-memory
node scripts/dsh-bridge.mjs send --session <返回的会话ID> --file <UTF-8任务文件>
node scripts/dsh-bridge.mjs wait --session <会话ID> --request <发送时返回的requestId>
node scripts/dsh-bridge.mjs read --session <会话ID>
```

`send` 默认排队，并在调用前向 stderr 打印 requestId，随后向 stdout 输出接受结果。网络超时不能证明消息未送达；重试时传入原来的 `--request`，让宿主按原任务去重。`wait` 按 requestId 关联用户消息和所属 turn 的结束事件；如果用户消息写入前已失败，也可通过原生 inbox 插入/领取/取消事件关联，不把旧回复或空闲状态当成完成。模型错误、取消、阻断等返回 `stopped`。默认每次等待 60 秒；超时保留任务，不自动取消、不自动重发。

`read` 默认最近 50 条消息，`read --before <seq>` 向前翻页。`wait` 在同一个历史快照内自动向前查找，每页最多 200 条消息，默认最多 20 页；可通过 `--pages 1–100` 调整。达到上限仍未找到任务时明确返回 pending/history-window-exhausted；分页重叠或没有推进则报错。结果包含 pages、asOfSeq，供核对所检查的历史范围。

可使用 `list` 查会话、`cancel --session <id>` 取消目标会话当前轮次。取消沿用 DSH 的行为，不保证清空待处理队列。任务和结果仍显示在 DSH 会话中。插件创建的操作方使用 `interactions=none`，不替人回答权限审批；遇到工具审批或用户问题时，按 DSH 现有交互处理。

建议为协作建立专用会话。由 Codex 分配明确的审查、定位或修改任务，DeepSeek 返回文件位置、补丁与验证结果，Codex 检查后整合。同一时刻为两者划分文件范围，避免同时修改同一文件。仅安装桥接不会自动分发任务，也不会使当前聊天在结束后持续运行；后续有新任务时可以继续调用同一个 DSH 会话。

## DSH 主动联系 Codex

桥接 0.2.0 增加本机持久收件箱。DSH 可以主动发请求，Codex 消费后将回复送回发件会话，不需要用户复制消息。数据保存在 `~/.dsh/codex-bridge/mailbox.sqlite3`，不放进代码仓库，不另开网络端口，不需要新的模型 API Key。CLI 现在就能使用；可选的 DSH 系统上下文说明在下次加载 bundle 后对所有会话可见。

DSH 先用文件工具写 UTF-8 请求，再运行：

```powershell
node scripts/codex-mailbox.mjs send --session <当前DSH会话ID> --file <请求.txt> --id <稳定消息ID>
node scripts/codex-mailbox.mjs read --id <稳定消息ID>
node scripts/codex-mailbox.mjs status
```

同一消息重试时沿用 id 和原文；不同内容必须用新 id。优先用 `--file`；Windows PowerShell 5 默认管道编码可能把中文变成问号。`--file -` 仅适合已经确保 UTF-8 的标准输入。

Codex 活动期间读取并回复：

```powershell
node scripts/codex-mailbox.mjs receive --consumer <消费者名> --wait-ms 45000
node scripts/codex-mailbox.mjs heartbeat --consumer <消费者名>
node scripts/codex-mailbox.mjs reply --id <消息ID> --consumer <消费者名> --file <回复.txt>
node scripts/codex-mailbox.mjs deliver
node scripts/codex-mailbox.mjs offline --consumer <消费者名>
```

`receive` 最多等待 45 秒，领取的请求及消费者租约默认 90 秒；处理期间续约，过期后先重新领取。只允许一个有效消费者。`offline` 释放该消费者未答复的请求。回复先落库，再通过原有 DSH 鉴权 API 排队投递；断线后用 `deliver` 重试，同一回复复用同一个 DSH requestId，避免重复执行。命令退出码 2 表示回复已保存、DSH 投递待重试。

| 状态 | 可确认的事实 |
| --- | --- |
| `pending` | 请求已保存，等待消费者领取 |
| `claimed` | 消费者已领取，租约有效 |
| `response-ready` | 回复已保存，等待送回 DSH |
| `response-queued` | DSH 已接受回复，尚不能证明模型完成处理 |
| `receiver.state=polling` | 消费者最近轮询，租约有效 |
| `receiver.state=offline` | 无有效消费者；请求会保留 |

**常驻接收与唤醒是不同能力。** 收件箱不自动启动模型，不能唤醒已结束的 ChatGPT/Work 聊天，`wakesCodex` 固定为 `false`。若要无人值守地在聊天结束后继续运行，需要另外运行受控的 Codex 驱动程序。官方 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 提供 `thread/resume`、`turn/start` 等接口，但本插件没有自动启动另一个模型会话，也不把 CLI 登录状态当成本聊天可被唤醒的证明。

2026-10-26 已在真实 DSH 专用协作会话中完成“DSH 主动发件 → Codex 读取 → 原会话收到回复 → DSH 再发确认”的闭环。

## 有截止时间的自动接收进程

`codex-mailbox-worker.mjs` 使用本机已登录的 Codex CLI，通过官方 stdio App Server 创建独立协作线程。它轮询同一个收件箱，逐条处理允许的 DSH 会话请求，再回信。它不向当前 Work 聊天注入回合，也不读取或导出登录凭据。

```powershell
# 在受控终端中运行；时间和会话按当次授权填写。
node scripts/codex-mailbox-worker.mjs serve --until '2026-10-26T08:00:00+08:00' --session <DSH会话ID> --max-tasks 20 --codex <codex.exe绝对路径>
node scripts/codex-mailbox-worker.mjs status
node scripts/codex-mailbox-worker.mjs stop
```

截止时间必须在未来 12 小时内；最多 30 条请求，默认 12 条。0.2.1 将旧的固定 10 分钟单轮限制改为 **10 分钟无进展超时**：模型或工具有实际进展时续计时，另保留 **30 分钟绝对上限**；截止或 stop 也会中断活动轮次。RPC 接纳另设 60 秒传输期限，不与无进展计时混用。空闲时只保留队列消费者，收到允许的请求后才建立独立的模型进程和线程，完成后关闭，避免长期持有闲置模型连接。它使用 CLI 当前配置的模型和登录；模型调用会消耗对应账号额度。网络沿用进程环境，必要时在启动它的终端中设置现有 `HTTP_PROXY` / `HTTPS_PROXY`，不改全局设置、不硬编码代理或凭据。

发起前先让交互消费者 `offline`，避免两个消费者抢同一消息。状态文件位于收件箱旁的 `worker.json`；过期心跳或进程消失会显示 `offline-stale`。

单个任务超时或失败会给原 DSH 会话发送明确的“本轮未完成”回执，附线程、轮次及最后公开进度；不把中断前的进度当成最终验收。**已确认终止的失败不会退出接收进程，下一条请求继续运行**，但不自动重跑已有代码。若无法确认执行已终止，状态转为 `quarantined`：仍能接收并回复原因，暂停新的代码执行，等待核对。隔离状态跨重启保留；未经核对的旧崩溃日志也不会因重复启动被清掉。DSH 断线时回复继续保存在库里，之后可用 `deliver` 补投。

协作回复及接收结束通知使用原生 `steer` 投递到 DSH 的下一步边界；DSH 正忙时也不必等整轮结束才看到回复，不取消现有任务。普通 CLI 分配任务仍默认 `queue`。

到期、达到任务上限或主动停止时，进程会尝试向允许的 DSH 会话发送结束通知；`shutdownNotified` 记录是否成功，断网时不保证即时通知。`processed` 包含已答复的失败和拒绝，`failures` 单独统计模型失败。`response-queued` 仍只代表传输已接受，不能当作代码任务成功。

白名单之外的会话不启动模型轮次。工作线程默认只获仓库写入范围、审批为 never，不代答权限问题，不自动创建其他代理或调度器；开发范围写在 `workerInstructions` 中。进程停止后不自动复活；未安装系统启动项或计划任务。电脑休眠、关闭终端或服务宿主退出会中断持续处理，未完成请求保留待恢复。

本机桥接隔离回归 52 项通过，覆盖快速完成的通知顺序、跨线程串话防护、空闲不启动模型、进展续时、绝对上限、失败后继续接收、隔离、防重复执行、租约、steer 及补投。真实“人为触发一轮超时 → 明确回告 DSH → 下一轮真实模型成功回复”已通过；此前 0.2.0 有过整进程因单轮超时退出的故障，0.2.1 针对该问题修复，持续运行仍以 `status` 和具体回执为准。

## 本机真实验收（2026-10-25）

桌面端重启后，已通过原生本地 API 完成鉴权、创建会话、重命名、发送任务、读取工具结果和按 requestId 等待轮次结束。专用会话名为 `Codex × DeepSeek 插件协作`，会话 ID 为 `session-48b4abe9-ab62-42e9-86ab-60bb62eccfea`，工作目录为 `D:/dsh-plugins/dsh-companion-memory`。当时宿主记录的模型为 `deepseek-v4.1-flash`。

DeepSeek 实际调用 read/grep 工具读取了 AGENTS.md、package.json 和 src/adapters/host-service.ts，返回指定验收标记并正常结束轮次。该任务仅要求只读检查；没有测试代码修改或工具权限审批。简化验收记录位于 `artifacts/codex-bridge-smoke-response.json`；供后续调用复用的会话定位信息位于 `artifacts/codex-bridge-worker.json`。两份记录不含连接凭据或完整系统提示词。

## 回退

从 profile package.json 删除 `dsh-codex-bridge` 的依赖与 bundles 条目，重新加载/重启 DSH。安装脚本在原 package.json 旁保存 `.codex-bridge-时间戳.bak`；恢复整份备份前应核对期间是否有其他 profile 修改。会话和伴侣记忆不会被删除。
