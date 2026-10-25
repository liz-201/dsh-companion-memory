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

## 本机真实验收（2026-10-25）

桌面端重启后，已通过原生本地 API 完成鉴权、创建会话、重命名、发送任务、读取工具结果和按 requestId 等待轮次结束。专用会话名为 `Codex × DeepSeek 插件协作`，会话 ID 为 `session-48b4abe9-ab62-42e9-86ab-60bb62eccfea`，工作目录为 `D:/dsh-plugins/dsh-companion-memory`。当时宿主记录的模型为 `deepseek-v4.1-flash`。

DeepSeek 实际调用 read/grep 工具读取了 AGENTS.md、package.json 和 src/adapters/host-service.ts，返回指定验收标记并正常结束轮次。该任务仅要求只读检查；没有测试代码修改或工具权限审批。简化验收记录位于 `artifacts/codex-bridge-smoke-response.json`；供后续调用复用的会话定位信息位于 `artifacts/codex-bridge-worker.json`。两份记录不含连接凭据或完整系统提示词。

## 回退

从 profile package.json 删除 `dsh-codex-bridge` 的依赖与 bundles 条目，重新加载/重启 DSH。安装脚本在原 package.json 旁保存 `.codex-bridge-时间戳.bak`；恢复整份备份前应核对期间是否有其他 profile 修改。会话和伴侣记忆不会被删除。
