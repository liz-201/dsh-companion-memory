# 角色与情感连续性

默认情感性格为 `balanced`。普通 DSH 会话保留当前人设提供的身份与表达方式，记忆只补充该角色的经历、关系、心情及电脑信息。QQ 独立回复和主动消息仍可使用内置大肥鱼，不依赖外部人设插件。

## 完整提示词预设

桌面版通过 `systemPrompt.context({ required: true, interpolate: false })` 注册记忆运行时上下文。`complete:true` 仍独占系统提示词正文；记忆作为独立上下文交给宿主。关闭可选运行时上下文不会删除它，请求发送前的 `refreshContext()` 也能刷新它。记忆中的 `{{cwd}}` 等文本不进行模板插值。

关闭 `integration.enabled` 或 `integration.localOwner` 会停止本地监听与注册；`excludedAgentIds` 中的角色代理不会读取或记录私人记忆。该接入依赖桌面版的 context API；不保证所有旧版宿主支持完整预设。

## 角色识别与隔离

识别优先级：

1. 显式 `integration.personaId`。
2. DSH 当前选择的预设，身份为 `preset:<预设 id>`；读取当前 Session 投影或持久化选择事件，而非只读取创建时的 header。
3. 没有预设时，按 `*:persona` 与 `deployment:persona-prefix` 的非空正文生成 `prompt:<摘要>`。工作目录、模型和普通工具段不参与摘要。
4. 没有外部角色信息时使用 `builtin`，保留原大肥鱼的主人关系。

每个角色拥有独立的关系、心情、记忆、事件与会话绑定。切换角色不会清空原角色；切回相同身份即可恢复。排队中的后台提取绑定消息原本的角色，切换角色或复制到另一电脑后也不会串写。角色身份不含电脑 id；同一主人跨电脑复制同步文件后继续同一关系。

默认不把旧的、没有角色标签的共享历史自动分配给任意外部角色，它继续归属 `builtin`。这样避免把无法确认归属的争执、亲密度或私人记忆带入新角色。若要让某个外部角色明确继承这份历史，可以配置 `personaId: builtin`。

无稳定预设 id 的文本角色，修改正文会得到新身份。若只是修改同一角色的措辞，使用固定 `personaId`。不使用标准 persona 段名的第三方插件也应显式配置此项。不要给需要隔离的不同角色设置相同 id。

## 情感参数联动

外部人设的自然语言不被猜测成数值参数。按稳定角色 id 显式选择预设，或在对应会话执行 `/fish personality gentle`。命令只影响当前角色，不改其他角色，不替换人设正文，也不清空已积累的关系与心情。

```yaml
- id: dsh-companion-memory
  name: dsh-companion-memory
  config:
    companion:
      preset: balanced
    integration:
      personaPresets:
        'preset:whale': gentle
        'preset:fish': balanced
      # 只有需要固定/覆盖自动角色身份时才填写：
      # personaId: my-whale
```

`whale` 和 `fish` 是示例预设 id，不是插件包名。先在对应会话正常对话，再用 `/fish status` 查看当前角色 id，然后填写映射。没有映射时使用均衡默认值。显式 `/fish personality` 选择优先于映射，并随记忆包同步；映射保存的角色性格也随包复制到新电脑。

升级时，未显式选择的旧默认易怒参数会改为均衡，关系和心情保留。旧版持久化的 `companion.preset` 只适用于内置角色；显式配置或选择的易怒性格不会被强制改掉。

## 验证

`tests/integration/persona-continuity.test.mjs` 覆盖默认值迁移、角色切换、提取队列归属、性格命令、恢复与跨电脑导入。

`tests/integration/desktop-persona-runtime.test.mjs` 使用从本机 DSH Desktop 提取的 Cordis 和 SystemPrompt，实际加载插件入口、延迟提供可选服务、后台提取、完整预设、上下文抑制、请求前刷新、排除角色与卸载。没有这些本机宿主依赖时此测试会明确标记跳过。本次运行没有跳过。模型输出为测试数据，不代表真实模型的记忆召回质量。
