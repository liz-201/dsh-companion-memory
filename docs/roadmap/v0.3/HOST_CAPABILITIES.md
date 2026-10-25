# 桌面宿主能力实证

日期2026-10-24；开发版0.3.0-dev.1。协议来源为本机DSH Desktop 0.2.1-rc.2，安装包 `D:/dsh/resources/app.asar`。提取工具只读安装包，将运行依赖放入仓库artifacts；没有修改安装包或正在运行的会话。

| 项目 | 证据与实现 | 验证结论 |
| --- | --- | --- |
| complete预设与required context | `desktop-persona-runtime.test.mjs`，真实Cordis/SystemPrompt模块 | 通过；完整人设、suppress、refresh后仍保留必要上下文，记忆不插值 |
| 按会话识别模型请求 | 宿主buildRequest携带sessionId；local-integration只处理已观察的本地会话 | 真实LlmRuntime waterfall隔离测试通过；无sessionId的后台请求不被包装 |
| 首段文本前校验 | desktop-expression缓冲文本，guard通过后才yield | 真实LlmRuntime测试中被拦文本可见块数为0；不是发送后改历史 |
| 同步返回流 | `llm/stream` 拦截器直接返回 AsyncIterable，异步检查在生成器内部执行 | 按真实 agent loop 的方式直接 `for await (... of llm.stream(...))`，覆盖正常文本、拦截、后台/未跟踪会话与卸载；不先 await 返回值 |
| 工具、推理、usage与finish | 原块通过，文本按原index聚合；工具/推理边界前检查先前文本 | 单元协议测试通过；usage不重复，工具参数不改写；文本改写会丢弃不再可靠的provider replayState |
| abort/卸载 | 检查signal与active；自动关闭上游迭代器，释放监听 | 取消、卸载后调用的测试通过；完整UI取消体验未测 |
| 本地主动提交 | 真实Session.append assistant/message，surfaceOp=append；不伪造user输入 | 真实Session接受并可deriveMessages；同幂等ID只保留一条 |
| 抢话与角色变化 | 最后入站序号复核到append之间无await；切角色撤销旧目标和待发机会 | 协议测试通过；UI并发压力验证未完成 |
| 长输出 | 文本缓冲上限32KiB，超限明确失败，不无限缓存 | 代码实现；大规模UI长代码/工具回合未全面验收 |
| 人设继承 | 桌面主动生成沿用session已形成的system消息；缺失则放弃生成 | 实现存在；逐个外部人设插件的真实UI兼容需继续验收 |

复现：先运行 `node scripts/extract-host-test-runtime.mjs`，再运行 `node --test tests/integration/desktop-v03-protocol.test.mjs`。测试使用真实宿主模块与脚本模型，不调用用户模型、不写用户会话。

2026-10-24 修复：旧的 async 拦截器把流包装成 Promise，宿主直接迭代时会报 `stream is not async iterable`。原测试先 await `llm.stream()`，掩盖了返回类型错误；现已移除该 await 并断言返回值具有 `Symbol.asyncIterator`。修复已重新编译；`link:` 安装需重启 DSH Desktop 加载新代码，不涉及配置或数据库迁移。

**不能把上述协议验证说成已经完成真实桌面UI端到端验收。** 尚未验证：当前运行应用重启后的可见主动气泡、UI持久化刷新、各模型工具回合、极长输出体验。其他宿主版本未正式支持；应运行同一协议套件并记录差异。
