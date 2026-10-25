# v0.3 接口、持久化与运行契约

配套 [主任务书](IMPLEMENTATION_TASKBOOK.md)。本文件定义**待实现的插件内部接口**，不是 DSH 原生 API 文档。日期：2026-10-24。

## 1. 身份与类型

沿用现有 IdentityBinding；主键通过现有身份函数产生，不拼接未经转义的显示名称。`personaId` 是稳定角色标识，`principalId` 是该角色与交互对象的关系标识。设备不属于人格主键。角色显示名变化不应导致新身份；无法稳定识别外部预设时使用显式 integration.personaId。

以下接口是最小公共契约，实际实现补充 import/type guard；不使用 any。所有 number 入库前要求 finite，单位范围做边界验证。

```ts
type Trait = 'irritability' | 'sensitivity' | 'directness' | 'selfControl'
  | 'warmth' | 'initiative' | 'socialEnergy' | 'playfulness' | 'reserve'
  | 'conscientiousness' | 'curiosity' | 'optimism'

interface PersonalityProfile {
  schemaVersion: 2
  companionId: string
  personaId: string
  revisionId: string
  parentRevisionIds: string[]
  traits: Record<Trait, number>
  templates: Array<{ id: string; weight: number }>
  explicitOverrides: Partial<Record<Trait, number>>
  seed: string | null
  generatorVersion: string
  source: 'legacy' | 'owner' | 'mapped' | 'import'
  createdAtMs: number
}

type TaskMode = 'chat' | 'support' | 'task' | 'creative' | 'structured'
interface ExpressionPlan {
  ruleVersion: string
  principalId: string
  personalityRevisionId: string
  stateRevision: number
  mode: TaskMode
  stance: 'neutral' | 'interested' | 'supportive' | 'guarded' | 'hurt' | 'firm'
  ease: number
  openness: number
  warmth: number
  directness: number
  playfulness: number
  targetSentences: { min: number; max: number } | null
  addressHabitId: string | null
  allowedMemeIds: string[]
  requiredFacts: string[]
  sourceIds: string[]
  protectedSpans: Array<{ kind: 'code' | 'quote' | 'url' | 'literal'; text: string }>
  ruleIds: string[]
  reasonCodes: string[]
}

interface ExpressionIssue {
  code: string
  severity: 'hard' | 'soft'
  start: number
  end: number
  reason: string
  suggestedAction: 'keep' | 'lossless_edit' | 'regenerate' | 'block'
}

interface GuardResult {
  text: string | null
  status: 'pass' | 'repaired' | 'degraded' | 'blocked'
  issues: ExpressionIssue[]
  repairCalls: 0 | 1
  semanticChecks: Record<string, 'pass' | 'fail' | 'unknown'>
}
```

不把 `requiredFacts` 当模型任意新增事实的通道；值只能从原任务、已验证记忆和工具结果派生，带对应 sourceIds。保护原文 span 的确定性检查可以发现变化，但不能证明整个改写语义等价；语义 unknown 的关键事实重写应放弃该修复结果。

纯函数最小接口：

```ts
composePersonality(input: ComposeInput): PersonalityProfile
projectExpression(input: ExpressionInput): ExpressionPlan
lintExpression(text: string, plan: ExpressionPlan, history: ExpressionHistory): ExpressionIssue[]
rankOpportunities(input: OpportunityInput): RankedOpportunity[]
classifyFeedback(input: FeedbackInput): FeedbackProposal
```

输入都显式携带 nowMs，禁止在领域函数内 Date.now、Math.random、数据库读取或模型调用。随机初始化从可注入 PRNG 获得；回放使用已保存结果。

## 2. 主动互动与投递契约

```ts
type OpportunityKind = 'follow_up' | 'interest_share' | 'positive_revisit'
  | 'shared_topic' | 'repair' | 'reminder'
interface Opportunity {
  id: string
  principalId: string
  personaId: string
  conversationId: string
  kind: OpportunityKind
  sourceIds: string[]
  topicKey: string
  summary: string
  createdAtMs: number
  notBeforeMs: number
  expiresAtMs: number
  expectedInboundSeq: number
  status: 'pending' | 'selected' | 'sent' | 'expired' | 'cancelled'
}
type DeliveryTarget =
  | { channel: 'desktop'; sessionId: string; personaId: string }
  | { channel: 'qq'; accountId: string; chatId: string; personaId: string }
interface DeliveryAdapter {
  capabilities(): { send: boolean; idempotency: boolean; receiptLookup: boolean }
  send(input: {
    target: DeliveryTarget
    idempotencyKey: string
    content: string
    expectedInboundSeq: number | null
  }): Promise<{
    status: 'sent' | 'rejected' | 'unknown'
    externalMessageId?: string
    retryable?: boolean
  }>
}
interface ProactiveFeedback {
  id: string
  opportunityId: string
  outboxId: string
  principalId: string
  userMessageId: string | null
  kind: 'positive' | 'negative' | 'busy' | 'explicit_preference' | 'unrelated' | 'unknown'
  evidenceQuote: string | null
  confidence: number
  ruleVersion: string
  supersedesId: string | null
  createdAtMs: number
}
```

自动归因只有真实入站且证据通过时可生成非 unknown 的反馈；同一消息可以同时提供事实和反馈，但同类情绪事件以统一事件键去重。反馈修订用 supersedesId，不重复累加旧版本。接受度统计从有效反馈事件重算，不能同步后再把汇总数相加。

首版接受度计算固定为 `raw=(positive+2)/(positive+negative+4)`；busy、unrelated、unknown 不加入分母。按 topicKind 和四个当地时间段（00–06、06–12、12–18、18–24）分别建桶，样本不足五次时返回 .5；新有效反馈使生效值向raw移动最多 .05。按稳定事件顺序重放得到同一值，删除/修订反馈后从头重算。显式禁用主题是硬约束，不被平滑计数抵消。此公式是工程先验，不解释为真实“对方喜欢我的概率”。

关系事件独立经过原有 eligibility/日上限/幂等校验；positive feedback 不直接写 affection 字段。学习频率不能反向修改稳定人格模板，用户明确调整人格走新的配置修订。

`send` 的 expectedInboundSeq 检查必须尽量与宿主提交同一临界区完成；若宿主只能分离检查/提交，能力报告写明竞态窗口并补实现，不宣称绝对无抢话。Outbox 在发送前验证 target 的 persona 与当前绑定一致；不把旧角色消息投到已经切换角色的窗口。

## 3. 宿主适配验证清单

T01 新建 `docs/roadmap/v0.3/HOST_CAPABILITIES.md`，每项填写宿主版本、调用入口、实际证据、支持/不支持、限制，不留未经验证的“应该可用”。

1. required context 在 complete prompt 和刷新之后是否仍在；内容按 interpolate:false 注入。
2. llm/stream listener 是否可包装真实 AsyncIterable；能否从 options/受支持上下文可靠识别会话和 agent；识别不出时不全局劫持。
3. 文本、工具调用、推理、usage、结束、异常、abort 的实际 chunk 结构。必须保持工具块的时序与内容；修复只作用最终用户可见文本。
4. 流式文本是否在宿主 UI 展示前经过包装；不能在用户已经看到后修改历史假称提前检查。
5. buffered chat 的大小上限与取消；超限转受控分段校验或显式失败，不能无限缓存。建议上限 32 KiB，长任务按自然句/结构边界缓存，代码块原样传递。
6. 宿主工具回合若混有说明文本，要保证必要 tool call 不被 style guard 阻断；不能为了人设吞掉工具错误。
7. 主动 append 的受支持入口、事件来源、幂等 ID、回执；不直接修改宿主内部数据库。
8. agent/request 和 llm/stream 的用途区分：能改请求不代表能改输出。
9. 插件卸载/热重载正确撤销监听；两次挂载不会包两层；内部 repair/extract/consolidate 不被再次截获。

若宿主需要新增接口，交付最小扩展规格与版本绑定适配测试。不得默认修改 app.asar 或让用户用坏掉的版本“先凑合”。阶段实验可以只做提示改善，但正式 M04/M07 不能据此签收。

## 4. 迁移规划

下述 005–007 是建议编号，实施前再次检查目录并选择下一未占用编号。001–004 不允许改。迁移 SQL 使用事务和现有 checksum 机制；备份由既有封闭导出/SQLite 一致性方式完成，不能直接复制正在写入的主库而忽略 WAL。

### 005_personality_profiles.sql

| 表 | 必要字段/键 | 约束 |
| --- | --- | --- |
| personality_profiles | revision_id PK, companion_id, persona_id, parent_revision_ids_json, traits_json, templates_json, overrides_json, seed nullable, generator_version, source, created_at_ms | JSON合法；12维由应用校验；修订不可变；索引 companion/persona |
| personality_heads | companion_id + persona_id 联合PK, revision_id FK, conflict_json nullable | 单一本地生效修订；并发分叉保留而非时间戳强行覆盖 |

迁移读取每个旧角色已有 personality，原样保留6维；新增6维=.5；revisionId 使用稳定迁移键，重复导入不重建。没有实际角色记录时不批量创造人格。

### 006_expressive_memory.sql

| 表 | 必要字段/键 | 约束 |
| --- | --- | --- |
| episodic_annotations | id PK, principal_id, episode_id nullable, source_ids_json, appraisal_json, interpretation_json, supersedes_id nullable, created_at_ms, rule_version | 当时评价与后来解释分字段；必须有来源 |
| expression_habits | id PK, principal_id, kind, value_json, scope_json, status, confidence, source_ids_json, revision_id, supersedes_id nullable, valid_from_ms, valid_until_ms nullable | status=proposed/active/revoked；无来源不能active；显式偏好优先 |
| memory_lifecycle | memory_id PK/FK, archive_state, last_retrieved_ms nullable, tombstone_event_id nullable | 归档可恢复；删除不可通过合并自动恢复 |

继续复用 memories/raw_messages/episodes 和既有来源表，不复制第二套事实。已有 interaction_rule 转入新习惯表示时使用映射ID，避免重复注入；兼容读取旧类别但写入只使用新统一入口。来源删除使其派生项失效，并重算其他仍有证据支持的项目。

### 007_proactive_learning.sql

| 表 | 必要字段/键 | 约束 |
| --- | --- | --- |
| proactive_opportunities | 对应 Opportunity 字段、source_ids_json、评分分项JSON | source稳定键唯一；本地运行态，不导出执行 |
| proactive_feedback | 对应 ProactiveFeedback 字段 | 反馈有效版本唯一参与统计；unknown无关系增量 |
| proactive_ownership | companion_id PK, active_device_id, revision_id, parent_revision_ids_json | 并发接管冲突时本机停止非约定主动发送并提示 |
| expression_audits | id PK, principal_id, message_id, rule_version, mode, issues_json, status, estimated_tokens, repair_calls, latency_ms, created_at_ms | 默认不含完整正文；本地诊断默认不导出 |

既有 outbox 增加 target_json、opportunity_id、persona_id、origin_device_id（先允许 null，完成回填后由应用约束新行非空）。复用其状态机，不建立独立的第二条发送通道。

外键依赖顺序为 identity → profile/episode/memory → habit/feedback，导入在一个事务中校验后提交。新表 JSON 每字段设大小上限，禁止超大导入消耗内存。具体上限统一定义在 codec 并覆盖边界测试。

## 5. 同步格式 v2

保持现有校验封装，增加 `formatVersion:2`、`schemaVersion`、`minReaderVersion` 和逻辑事件集合。校验和只保证完整性，不提供保密或作者认证；拷贝文件包含私人记忆，沿用用户自己的存储权限。

导出：不可变人格修订和head、有效习惯及撤销事件、情景来源、反馈事件、记忆删除标记、主动设备归属。保留已有事实/关系事件和设备记录。**不导出可执行的 pending/sending outbox、定时器、临时目标句柄、修复缓存或模型密钥**；已发送互动的逻辑ID和反馈关联可导出，不在新机重新发送。

合并规则：

1. 导入前检查版本、大小、sha256、角色范围和引用合法性；未知未来版本直接拒绝并保留原库。
2. 事件ID幂等并集；快照和接受度由确定性有效事件重算，禁止直接平均两个 trust 或相加反馈计数。
3. 人格同一祖先后的单链修订取后继；并发分叉保留本地当前head并标冲突，等待明确选择，不能凭设备时钟决定谁正确。
4. 删除/撤销优先于旧值导入；用户明确恢复必须创建新的恢复事件，不能因旧包复活。
5. 设备时钟异常时，不用未来时间直接衰减整段关系；沿用稳定序列/因果关系，记录异常诊断。持续时间在本机用单调计时，持久时间采用UTC与合理范围校验。
6. 新版可读 v1 并生成稳定 legacy profile；旧版读 v2 应清楚报不支持。默认不导出丢失新功能的 v1；如提供兼容导出，标明人格/反馈等信息丢失范围，需用户显式选择。
7. 拷贝同步不保证两台离线同时运行的互斥。设备接管的操作说明必须诚实写清这一点。

## 6. 新配置建议与迁移

以下是目标配置，当前 v0.2 不能直接照抄运行。全部字段要在 src/config.ts 中严格解析、验证并测试，不能只在文档出现。

```yaml
personality:
  mix: { gentle: 0.45, earnest: 0.35, playful: 0.20 }
  overrides: { reserve: 0.65 }
  variation: { enabled: false, maxDelta: 0.05, seed: null }
expression:
  mode: enforce                 # 正式模式；diagnostic 仅开发评测
  repairMaxCallsPerTurn: 1
  repairMaxCallsPerDay: 10
  historyTurns: 10
  auditRetentionDays: 30
proactive:
  enabled: true
  checkMinutes: 5
  spontaneousLimitPerDay: 2
  spontaneousMinGapMinutes: 180
  pauseAfterUnanswered: 1
  quietStart: '23:00'
  quietEnd: '08:30'
  timezone: Asia/Shanghai
  opportunityThreshold: 0.35
  maxGenerationCallsPerCandidate: 1
  shareSources: []              # 没有配置不自动爬取用户内容
```

personality.mix 仅用于新角色初始值；按角色的配置覆盖应沿现有 personaId 映射扩展成同样结构，不以显示名为key。既有 `companion.preset`、`integration.personaPresets` 映射到 legacy 配置并保留最终6维。已保存用户设置高于默认。

旧 `integration.naturalExpression:true` 映射 enforce；false 不静默改变为 enforce，迁移报告告知旧关闭选项已不属于本版正式模式，保留 diagnostic 状态直至用户选择正式模式。新安装默认 enforce；此兼容态不能通过本版完整验收。开发者不得通过默认关闭模块回避 MUST 条件。

范围：repairMaxCallsPerTurn 0..1，日限0..100，historyTurns 1..50，审计保留1..365天，variation.maxDelta 0...05，threshold -1..1，频率和时区沿现有验证并补充 IANA 时区合法性。0次修复仍保留检查与降级；不是关闭自然表达。配置中的内容来源不能携带执行命令。

## 7. 事务、幂等与故障顺序

被动回合：绑定身份 → 持久原始入站（幂等） → 快照投影/检索 → 计划 → 原模型生成 → guard → 宿主提交 → 保存表达摘要/审计 → 后台事件提取与整理。宿主提交失败不能把未显示文本当共同经历。

主动回合：候选选定 → 复核预算 → 生成及guard → 原子写 outbox+候选selected → worker领取 → 二次闸门 → 投递 → receipt落库 → 更新candidate结果。模型调用不持有SQLite长事务。

恢复规则：sending未获确定回执变unknown；unknown不盲重发；若平台提供幂等查回执则使用同键查询。明确rejected且retryable才有界重试，重试前再检查expiry、persona与入站序号。候选键由 principalId+kind+sourceIds+版本组成，不用每次扫描时间制造“新候选”。

用户停止、遗忘或切角色时，取消相关待发机会与outbox；已发消息不回滚成未发。每个persona有队列串行化主回合与主动提交；跨角色仍遵守同一用户的全局日限，避免八个角色各发两条造成轰炸。默认全局上限2，角色上限也2；明确约定提醒分开。

## 8. 实现完成后的新增测试文件

建议至少：`personality-composition.test.mjs`、`expression-plan.test.mjs`、`expression-guard.test.mjs`、`habit-learning.test.mjs`、`proactive-feedback.test.mjs`、`desktop-proactive.test.mjs`、`expression-stream-contract.test.mjs`、`portable-v2.test.mjs`。固定时钟和临时库；真实桌面/模型验证另出报告，不把 mocked host 称作真实桌面通过。
