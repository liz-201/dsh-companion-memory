# 兼容性

插件在 `apply()` 时跑一次**能力探测**（`src/adapters/compatibility.ts`），把宿主能力分成
「有 / 降级 / 阻塞」三档，并把结论写进 `ctx.logger` 与 `/fish status`。
不假设宿主一定有什么，缺什么就降级什么，**不假装做到**。

## 探测的能力

| 能力 id | 探测方式 | 缺失后果 |
| --- | --- | --- |
| `systemPrompt` | `ctx.systemPrompt?.section` 是函数 | 降级：人设/协议改走消息前缀（占正文预算） |
| `tools` | `ctx.tools?.register` | 降级：交付档位掉到 `plain-body-only` |
| `agents` | `ctx.agents?.list` 或 `ctx.get('agents')` | 降级：人格作用域无法按 Agent 隔离 |
| `sessions` | `ctx.sessions?.get` | 降级：无法回写会话历史，仅本地记账 |
| `commands` | `ctx.commands?.register` | 降级：`/fish` 系列不可用，其余功能照常 |
| `llm` | `ctx.llm?.stream` | 降级：无法调用模型，只做存储与检索 |
| `systemPromptEvent` | `ctx.on('system-prompt/…')` 可用 | 降级：不做提示词热更新 |
| `agentLoopEvent` | `ctx.on('agent/…')` 可用 | 降级：不做回合前后钩子 |
| `webServer` | `ctx.webServer` / `ctx.get('webServer')` | 可选：只影响 HTTP 诊断入口 |
| `onebotHttp` | `GET <onebotHttpBase>/get_status` 成功 | 降级：主动消息停在 outbox，不宣称已送达 |
| `chatSessionsFile` | `chat-sessions.json` 可读 | 降级：无法把 session 映射到 QQ 会话 |

## 两个交付档位

- **`full`**（`systemPrompt` + `tools` 都在）：人设与协议进系统提示，模型输出按
  `<say>/<evt>` 协议解析，事件在正文发出后应用。
- **`plain-body-only`**（缺一）：正文照发，协议标记不注入模型；事件改由后台提取
  （`consolidate` 任务）补，**不声称达到首字节延迟指标**（规格 §13.3）。

当前本机实测：`delivery = full`。

## 与宿主版本的关系

| 宿主 | 结论 |
| --- | --- |
| DSH Desktop 0.2.1-rc.2（本机） | 已实测挂载：`apply()` 完成、命令注册、服务暴露、卸载无残留 |
| 更早版本（无 `ctx.systemPrompt.section`） | 自动降级为 `plain-body-only`，不报错 |
| 非 Desktop 宿主（纯 CLI） | 能用：SQLite + 记忆 + 命令；QQ 通道缺失时主动消息留 pending |

## 与 QQ 桥的关系

插件**不自己收消息**（规格 §13.2：不启动第二个入站消费者）。它提供可选服务
`companionMemory`，由 `dsh-onebot-qq` 这类桥把入站消息交给它、并消费它的出站队列；
0.2.0 中，即使桥不在，插件也通过宿主 `session/event` 记录普通 DSH 会话，在后台提取情感与记忆，并通过 `system-prompt/assemble` 注入上下文。QQ 已映射的会话不走本地监听路径，避免重复记录。具体接口与版本限制见 [SYNC.md](SYNC.md)。

## 已知不兼容点

- 宿主若同时装了两个「人格提示注入」插件，两段提示会叠加；本插件用独立 section 名
  `companion-memory:*`，不与 `deployment:persona-prefix` 冲突，但内容仍会重复。
- 宿主把 `ctx.llm.stream` 换成非流式接口时，协议解析退化为整段解析（仍可用，但失去首字节优势）。

## 2026-10-24 桌面版角色连续性修复

可选服务现在通过 `ctx.get()` 发现，context / commands 通过子依赖注入等待服务出现，不再使用宿主不支持的 `required/optional` 元信息。普通会话的记忆以 required runtime context 提供，完整预设和可选上下文抑制不会删除它；上下文中不注入大肥鱼身份。关系与心情按当前角色隔离，默认性格为均衡。详见 [PERSONA_CONTINUITY.md](PERSONA_CONTINUITY.md)。

当前验证使用从桌面版提取的实际加载器与提示词组件，加隔离数据库和模拟模型输出；没有操作运行中的桌面会话。旧版宿主和真实模型的最终表达需单独验证。
