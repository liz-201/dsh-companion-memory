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

桥接 0.2.0 增加本机持久收件箱，0.3.0 增加任务类型和接收器内部多线程调度。DSH 可以主动发请求，Codex 消费后将回复送回发件会话，不需要用户复制消息。数据保存在 `~/.dsh/codex-bridge/mailbox.sqlite3`，不放进代码仓库，不另开网络端口，不需要新的模型 API Key。可选的 DSH 系统上下文说明在下次加载 bundle 后对所有会话可见。

收件箱 schema 1 会自动升级为 schema 2，原有消息及回复保留，旧消息的 `kind` 默认为 `write`。不需要手工迁移、删库或重新发送旧消息。

DSH 先用文件工具写 UTF-8 请求，再运行：

```powershell
node scripts/codex-mailbox.mjs send --session <当前DSH会话ID> --kind chat --file <沟通.txt> --id <稳定消息ID>
node scripts/codex-mailbox.mjs send --session <当前DSH会话ID> --kind review --file <审查.txt> --id <另一稳定消息ID>
node scripts/codex-mailbox.mjs send --session <当前DSH会话ID> --kind write --file <修改任务.txt> --id <新稳定消息ID>
node scripts/codex-mailbox.mjs read --id <稳定消息ID>
node scripts/codex-mailbox.mjs status
```

| `--kind` | 工作范围 | 结果的含义 |
| --- | --- | --- |
| `chat` | 只读沟通、简短答复或进度问题 | 不修改源码，不执行长时间构建或测试 |
| `review` | 为当前输入创建独立副本，在副本内审查、修改验证和构建测试 | 报告对应快照 manifest，不自动合入主仓库 |
| `write`（默认） | 修改主仓库，并验证明确授权的改动 | 所有主仓库写任务共用一个全局互斥锁 |

省略 `--kind` 兼容原来的写任务行为。不同意图应分别发送，例如写任务执行期间的进度问题使用 `chat`，避免把同一个写任务反复排队。只有会话、kind 和原文都相同时才沿用同一 id；不同请求必须用新 id。优先用 `--file`；Windows PowerShell 5 默认管道编码可能把中文变成问号。`--file -` 仅适合已经确保 UTF-8 的标准输入。

Codex 活动期间读取并回复：

```powershell
node scripts/codex-mailbox.mjs receive --consumer <消费者名> --wait-ms 45000
node scripts/codex-mailbox.mjs heartbeat --consumer <消费者名>
node scripts/codex-mailbox.mjs reply --id <消息ID> --consumer <消费者名> --file <回复.txt>
node scripts/codex-mailbox.mjs deliver
node scripts/codex-mailbox.mjs offline --consumer <消费者名>
```

`receive` 最多等待 45 秒，领取的请求及消费者租约默认 90 秒；处理期间续约，过期后先重新领取。只允许一个有效消费者；多线程由同一个接收器内部调度，不通过启动多个消费者争抢消息实现。`offline` 释放该消费者未答复的请求。回复先落库，再通过原有 DSH 鉴权 API 排队投递；断线后用 `deliver` 重试，同一回复复用同一个 DSH requestId，避免重复执行。命令退出码 2 表示回复已保存、DSH 投递待重试。

| 状态 | 可确认的事实 |
| --- | --- |
| `pending` | 请求已保存，等待消费者领取 |
| `claimed` | 消费者已领取，租约有效 |
| `response-ready` | 回复已保存，等待送回 DSH |
| `response-queued` | DSH 已接受回复，尚不能证明模型完成处理 |
| `receiver.state=polling` | 消费者最近轮询，租约有效 |
| `receiver.state=offline` | 无有效消费者；请求会保留 |

**常驻接收与唤醒是不同能力。** 收件箱本身不自动启动模型，不能唤醒已结束的 ChatGPT/Work 聊天，`wakesCodex` 固定为 `false`。若要无人值守地在聊天结束后继续运行，需要另外运行下文的受控 Codex 驱动程序。官方 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 提供 `thread/resume`、`turn/start` 等接口；独立工作线程不会向当前 Work 聊天注入回合，CLI 登录状态也不是本聊天可被唤醒的证明。

历史验收：2026-10-26 在 0.2.x 的真实 DSH 专用协作会话中完成“DSH 主动发件 → Codex 读取 → 原会话收到回复 → DSH 再发确认”的闭环。这不是 0.3.0 多线程并发的验收记录。

## 有截止时间的自动接收进程

`codex-mailbox-worker.mjs` 使用本机已登录的 Codex CLI，通过官方 stdio App Server 为任务创建独立协作线程。0.3.0 在同一个接收器中调度多个任务，按类型限制并行工作范围，再向对应的 DSH 会话回信。它不读取或导出登录凭据。

```powershell
# 在受控终端中运行；时间和会话按当次授权填写。
node scripts/codex-mailbox-worker.mjs serve --until '<未来12小时内的ISO截止时间>' --session <DSH会话ID> --concurrency 3 --max-tasks 20 --codex <codex.exe绝对路径>
node scripts/codex-mailbox-worker.mjs status
node scripts/codex-mailbox-worker.mjs stop
```

`--concurrency` 默认 3，允许 1–4。在有多个名额时，接收器为 `chat` 保留一个名额，长时间写任务或审查不占满全部位置；设为 1 时顺序处理。`write` 在主仓库全局互斥，即使增加并发或有多个会话，也不会让两个写任务同时修改主仓库。`review` 各自使用独立副本，可与写任务及其他审查并行。多个任务同时等待并不代表应该同时写同一批文件。

截止时间必须在未来 12 小时内；最多 30 条请求，默认 12 条。每个活动轮次沿用 0.2.1 的 **10 分钟无进展超时**：模型或工具有实际进展时续计时，另保留 **30 分钟绝对上限**。RPC 接纳另设 60 秒传输期限，不与无进展计时混用。空闲时只保留队列消费者，收到允许的请求后才建立独立的模型进程和线程，完成后关闭。它使用 CLI 当前配置的模型和登录；模型调用会消耗对应账号额度。网络沿用进程环境，必要时在启动它的终端中设置现有 `HTTP_PROXY` / `HTTPS_PROXY`，不改全局设置、不硬编码代理或凭据。

发起前先让交互消费者 `offline`，避免两个消费者抢同一消息。状态文件位于收件箱旁的 `worker.json`；过期心跳或进程消失会显示 `offline-stale`。`activeTasks` 列出所有活动任务，分别记录消息、类型、线程、轮次和 `stage`；兼容旧读取方的 `active` 只显示首个活动任务。判断队列是否阻塞、哪项仍在初始化或测试时，应检查整个 `activeTasks`，不能只看 `active` 或单个 `threadId`。

每个 `review` 的输入是主仓库当前文件的独立副本，包括已修改的源码和未追踪源码。快照默认放在 `artifacts/codex-reviews/`，排除 Git 元数据、运行目录、常见凭据文件和数据库，并写入含文件 SHA256、创建时间及可得 Git HEAD 的 manifest。复制与主仓库修改可能并行，因此 manifest 标识各文件实际复制的字节，不保证整棵目录来自同一时刻。报告须标明快照路径或 manifest；报告中的“构建通过”或“测试通过”仅针对该副本。当主仓库仍有未提交改动时，HEAD 也不能单独标识快照内容。审查产生的修改保留在副本，不自动复制回主仓库、不自动合并或推送；整合后仍须验证主仓库。被 Git 忽略的交接文档默认不复制，相关要求应附在请求正文。审查进程设置 Git ceiling 为副本父目录，防止普通 Git 命令向上发现主仓库。

单个任务超时或失败会给原 DSH 会话发送明确的“本轮未完成”回执，附线程、轮次及最后公开进度；不把中断前的进度当成最终验收。**已确认终止的失败不会退出接收进程，后续请求继续处理**，但不自动重跑已有代码。若 `write` 无法确认已经终止，会隔离进一步的主仓库写任务，等待核对；`chat` 仍可沟通，独立 `review` 不得绕过隔离写主仓库。隔离状态跨重启保留；未经核对的旧崩溃日志也不会因重复启动被清掉。DSH 断线时回复继续保存在库里，之后可用 `deliver` 补投。

协作回复及接收结束通知使用原生 `steer` 投递到 DSH 的下一步边界；DSH 正忙时也不必等整轮结束才看到回复，不取消现有任务。普通 CLI 分配任务仍默认 `queue`。自动回信最多四路投递，失败目标退避 30 秒并持久记录下次尝试时间，避免大量失败回信占住后续在线目标；手动 `deliver` 可立即重试，沿用原 requestId。状态文件按顺序原子保存，Windows 短暂占用时异步重试最多两秒；无法保存则停止执行并保留已有日志。

到期或主动 `stop` 时，接收器停止接纳新模型任务，中断全部活动轮次，并等待所有活动任务收尾；不会只停止 `active` 首项。达到任务上限后也不再领取新任务，并排空已接纳的任务。完成收尾后，进程尝试向允许的 DSH 会话发送结束通知；`shutdownNotified` 记录是否成功，断网时不保证即时通知。尚未领取的请求继续保存在收件箱。`processed` 包含已答复的失败和拒绝，`failures` 单独统计模型失败。`response-queued` 仍只代表传输已接受，不能当作代码任务成功。

白名单之外的会话不启动模型轮次。`chat` 只读，`review` 只获自己快照目录的写入范围，`write` 只获主仓库写入范围；审批为 never，不代答权限问题，不自行创建其他代理或调度器，开发范围写在 `workerInstructions` 中。进程停止后不自动复活；未安装系统启动项或计划任务。电脑休眠、关闭终端或服务宿主退出会中断持续处理，未完成请求保留待恢复。

历史验收（0.2.1）：当时的本机桥接隔离回归 52 项通过，覆盖快速完成的通知顺序、跨线程串话防护、空闲不启动模型、进展续时、绝对上限、失败后继续接收、隔离、防重复执行、租约、steer 及补投；真实“人为触发一轮超时 → 明确回告 DSH → 下一轮真实模型成功回复”也已通过。此前 0.2.0 有过整进程因单轮超时退出的故障，0.2.1 针对该问题修复。这些历史结果不构成 0.3.0 多线程、快照或当前主仓库的通过证据；当前验收须以对应版本、manifest、`status` 及具体回执为准。

## 0.3.0 验证记录（2026-10-27）

桥接相关的 9 个测试文件共 94 项回归通过，失败、取消、跳过均为 0。本次复跑日志为 `artifacts/bridge-parallel-all-tests.tap`；范围包括原生任务历史关联、schema 升级与领取、任务准入和并行调度、独立审查副本、失败回信退避、Windows 状态保存及 Desktop 桥接。这个结果只验证这些桥接测试，不代表同一工作区中的其他插件改动已经全部通过。

独立真实并发验证记录位于 `artifacts/bridge-parallel-live-1793106167661/report.json`。该次验证使用单独的收件箱和状态文件、本机 Codex CLI 及 App Server，接收器并发设为 3。两个 `review` 使用不同线程和不同副本目录；两项审查仍在执行时，第三个 `chat` 获得线程，观测到 `activeTasks` 峰值为 3。北京时间 21:02:57，chat 完成；两个 review 分别在 21:03:20 和 21:03:23 完成，表明短沟通没有等两项审查结束。三项均产生预期标记并达到 `response-queued`，接收器处理 3 项、失败 0 项，以 `task-limit` 收尾，活动队列为空。`response-queued` 仍仅证明 DSH 接受投递，不代表 DSH 已完成后续处理，也不证明生产代码通过验收。

Windows 状态文件曾在并发读取时出现 `rename worker.json` 的 `EPERM`。现在使用串行异步写入、调用时 JSON 快照和同目录独占临时文件；只对 `EPERM`、`EACCES`、`EBUSY` 异步退避，最多两秒。`codex-worker-state.test.mjs` 的 6 项可控 I/O 测试验证了顺序、快照、暂态重试、非暂态失败、临时清理和旧文件保留；修复后的上述真实并发验证也正常写出最终状态。没有使用删除现有 `worker.json` 再替换的回退方式。

这些是有截止时间、任务上限的独立验证。记录时正式接收器显示 `offline-stale`，独立验证进程也已结束；不能据此宣称正式接收器正在持续运行或全天候在线。实际接收是否可用，仍须检查当前 `worker` 状态和新请求回执。

## 本机真实验收（2026-10-25）

桌面端重启后，已通过原生本地 API 完成鉴权、创建会话、重命名、发送任务、读取工具结果和按 requestId 等待轮次结束。专用会话名为 `Codex × DeepSeek 插件协作`，会话 ID 为 `session-48b4abe9-ab62-42e9-86ab-60bb62eccfea`，工作目录为 `D:/dsh-plugins/dsh-companion-memory`。当时宿主记录的模型为 `deepseek-v4.1-flash`。

DeepSeek 实际调用 read/grep 工具读取了 AGENTS.md、package.json 和 src/adapters/host-service.ts，返回指定验收标记并正常结束轮次。该任务仅要求只读检查；没有测试代码修改或工具权限审批。简化验收记录位于 `artifacts/codex-bridge-smoke-response.json`；供后续调用复用的会话定位信息位于 `artifacts/codex-bridge-worker.json`。两份记录不含连接凭据或完整系统提示词。

## 回退

从 profile package.json 删除 `dsh-codex-bridge` 的依赖与 bundles 条目，重新加载/重启 DSH。安装脚本在原 package.json 旁保存 `.codex-bridge-时间戳.bak`；恢复整份备份前应核对期间是否有其他 profile 修改。会话和伴侣记忆不会被删除。
