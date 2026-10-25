# 人设插件兼容性检查（2026-10-24，修复前记录）

更新：下文是修复前的历史检查。现已修复入口依赖声明、可选服务访问、完整预设下的记忆上下文、默认性格与角色隔离。当前行为与验证见 [PERSONA_CONTINUITY.md](PERSONA_CONTINUITY.md)。QQ / 主动消息继续使用内置大肥鱼，这是本次确认保留的行为。此次源码修复不代表已经修改桌面 profile 的启用列表。

结论：普通 DSH 会话的追加上下文方式可以保留已有普通人设段，但当前 0.2.0 不能声称已经完整实现桌面版的“保持外部人设并持续产生记忆情感”。本次检查未修改源码或桌面配置。

## 已验证的行为

检查使用本机 DSH Desktop 的 Cordis 4.0.5 和实际 SystemPrompt 类，而非只手动调用 `apply()` 的模拟宿主。

在隔离数据库中，直接挂入本插件的普通会话观察模块，注册与鲸鱼娘插件相同的 `whale:persona` 段并关闭插值。发送一条真实用户来源的测试事件后，后台提取生成一条情感事件及带引文的偏好记忆。最终组装保留原人设全文和字面的模板示例，同时包含记忆与电脑信息，没有注入“蓝色大肥鱼”人设。

这是对普通人设 section 接口的组合验证；没有调用真实模型，也没有向 QQ 发送消息。它不能保证任意模型的人设表现完全不受新增状态影响。

## 当前阻塞与限制

1. **插件入口无法在当前桌面加载器中正常启用。** `src/index.ts` 使用 `inject = { required: [], optional: [...] }`。实际 Cordis 把这解释为两个服务名，插件等待 `required` 与 `optional`，没有执行 `apply()`。已用实际加载器复现。此前直接调用 `apply()` 的挂载测试不能覆盖此问题。修复声明时还需要同步处理直接访问未声明服务的代码，保证可选能力通过宿主支持的接口发现。
2. **本机桌面配置未安装或启用记忆插件。** 检查时 desktop profile 的 dependencies 与 bundles 中都没有 `dsh-companion-memory`。`dsh-desktop-cwd-compat` 只是工作目录兼容插件，不提供记忆情感功能。
3. **QQ 与主动消息会绕开外部人设。** QQ 回合通过 `TurnCoordinator` 加载 `prompts/persona-*.txt` 并自行调用模型；主动消息通过 `composePersonaText()` 走同一内置人设。组合验证中，即使有外部鲸鱼娘人设，QQ 请求仍使用“蓝色大肥鱼”。配置的 `integration.mode=augment` 当前没有接到这些分支上。
4. **完整提示词接管预设会丢掉追加记忆段。** 宿主遇到 `complete:true` 的 section，会在 waterfall 返回后把 sections 恢复为唯一的 complete section。实际 SystemPrompt 组合验证中，人设保留，但 `companion-memory:local` 消失。需要通过宿主兼容的动态上下文机制等方式接入，并验证预设对动态上下文的抑制行为。
5. **情感参数与人设尚未联动。** 默认使用 `companion.preset=irritable` 的情感参数；同一 companion/owner 只有一份关系状态，不按外部人设插件或角色分别存储。普通会话不注入内置角色身份，但情感敏感度不会自动从外部人设中推导。

## 达到目标所需的修正

先修复实际宿主的加载及可选服务获取；默认增强模式应由 DSH 原会话和人设生成可见回复，插件提供记忆、情感、设备上下文与后台提取。QQ 及主动消息也应明确复用当前角色。内置人设只在明确选择独立角色模式时使用。之后验证普通人设、完整接管预设、角色切换、重启与跨电脑同步的组合场景。

## 复现材料

- `artifacts/review-persona-compatibility.mjs`：隔离检查脚本，使用已提取的本机宿主依赖。
- `artifacts/persona-compatibility-review.json`：本次真实检查结果。
- 该脚本断言的是修复前行为，仅供历史比对；当前回归请运行 `node --test tests/integration/persona-continuity.test.mjs tests/integration/desktop-persona-runtime.test.mjs`。

本次没有变更用户的人设、聊天记录、插件启用列表或实际会话。
