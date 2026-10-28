# 情感联动修订任务书（2026-10-29）

版本：1.0。代码核查基线：`c7eb86d` / `0.3.0-dev.9`，数据库迁移 001–008，导出格式 v4。本文件修订 2026-10-26 规格，并吸收 2026-10-28 DSH 复查；它是本轮实施与签收依据，不是新功能全部完成的报告。原文档的日期和历史成绩保留，不能拿旧标题代替当前运行版本。

沿用 [R01–R16](IMPLEMENTATION_TASKBOOK.md) 与 [A01–A34](ACCEPTANCE.md)。本轮不重开已经确定的统一主人决定：同一本人的对话、模型、人设共享长期状态；不同 owner 隔离。宿主人设影响表达，不自行建立另一段关系。

## 1. 复查结论与需要纠正的误报

| 项目 | `c7eb86d` 实际状态 | 本轮处理 |
| --- | --- | --- |
| OCC、PAD、联系驱力与回应账本 | 已有 `emotion-appraisal.ts`、`occ-classifier.ts`、`pad-projector.ts`、`drive-projector.ts`、`storage/continuous-affect.ts` 和迁移 008 | 保留来源、回放、撤回、删除和同步规则，不为补功能重写已应用迁移 |
| 58 个核心场景 | `tests/unit/continuous-emotion.test.mjs` 已有 22 类各正反例及 7 组中文显示场景各正反例 | 不再写“58 断言尚未实现”；这些是自动夹具，仍需独立语料与人评 |
| 已安装目录没有测试代码 | `package.json.files` 与 `scripts/package.mjs` 有意只包含 `tests/fixtures` | 测试从源码整合树执行；发行目录缺 `*.test.mjs` 不等于源码没有测试 |
| support / task 连续情绪 | `renderPlan` 的细分情绪方向仅在 chat 输出；但 `projectExpression` 已能凭本轮 distress cue 选择 supportive stance | 修细分方向与任务边界，不能声称现有 support 完全没有关心语气 |
| 旧策略的 appraisal | `turn-coordinator.ts` 给 `decideStrategy` 的 appraisal 写死为 undefined | 接入当前源消息的有效信号；不能借用另一条消息的评价 |
| 策略四分支“全部不可执行” | 需要 appraisal 的分支受限；`appraisal === undefined` 的分支反而可进入。`checkContinuity` 是另一函数 | 区分策略与诊断调用点，按真实入口验证 |
| “失落” | `distress` 也会触发该显示词，且 `renderPlan` 缺少对应方向 | 收窄语义并补表达；普通离线、忙碌或未回复不能自动认定被拒绝 |
| PAD 替换旧 Mood | 两套来源目前并行，没有通用逆投影函数 | 按第 4 节分阶段兼容，不承诺三轴无损还原五槽 |
| intimacy / desire / passion / commitment | 正式整合树没有完整的关系扩展；旧工作区的 `drive.ts` 草稿不等于发布实现 | 先冻结来源和契约；commitment 暂未决定，不能虚构人物承诺 |
| 情绪时间线 | 控制台已有当前状态与评价依据列表，尚非按来源时间组织的时间线 | 提供有界、可解释的历史视图；不把 revision 归档表当全部事件 |

本轮只读复核在基线生成物上实际执行五个文件：`continuous-emotion`、`continuous-affect`、`emotion-evaluation`、`emotion-withdrawal`、`continuous-portable`，83/83 通过、0 失败、0 跳过。该结果不包含本轮后续改动，也不等于全量 543 项、真实模型或双物理机签收。

## 2. 工作包与双方交付

双方均可承担实现和修改，按独立分支、文件归属和交叉复核组织，不固定为“一方实现、另一方只反馈”。下表的“待实现／待签收”不因文档完成而自动变成通过。

| 包 | 要求 | 实施内容 | 必须出示的证据 | 状态 |
| --- | --- | --- | --- | --- |
| N01 模式与显示方向 | R06/R11；A27–A29 | 五模式权限、混合求助情境、失落的范围与表达 | 真实 `ExpressionRuntime -> renderPlan` 路径；格式保真与正反例 | 待实现／签收 |
| N02 当前评价与检索接线 | R04/R11/R16；A27/A30 | 当前消息有效评价进入策略；PAD 的检索影响有明确来源和回退 | 当前源／旧源／删源／后台未完成／前置超时；事实查询情绪加成仍为零 | 待实现／签收 |
| N03 调节与表达可靠性 | R08/R12；A24/A25/A28 | 高强度信号限制自我展开、玩笑或重复表达，沿用发送前守卫 | 计划变化可观察；高兴、支持、引用、JSON、代码不被误伤 | 待实现／签收 |
| N04 时间线与词义说明 | R04/R14；A12/A33 | 以 source time 展示评价与派生状态，解释未知、撤回、来源和参数 | 同时刻稳定排序、迟到重排、撤回／删除可解释，UI 输出安全 | 待实现／签收 |
| N05 PAD 兼容与关系扩展 | R07/R10/R13；A09–A13/A31/A32 | 第 4、5 节的分阶段来源与兼容契约 | 重放哈希、旧包、合并冲突、回退；不能只测域层 | 分阶段提案，接口待确认 |
| N06 词表与人评 | R06/R15；QA01 | [中文词表](CHINESE_EMOTION_LEXICON.md)、[人评表](HUMAN_EVALUATION.md)、同模型对照 | 自动夹具与人工结果分开；报告失败、未测、成本 | 规格交付；人评未测 |

DSH 本轮表达实现的约定范围是 `task-mode.ts`、`policy.ts`、`occ-classifier.ts`、对应测试与表达模式说明；Codex 负责其余已分配的接线、整合和最终验证。新接口、共用文件先交接，任何一方都不覆盖原工作区未知草稿。实际完成提交及最终测试数字写入交付报告，不在这里预填。

## 3. 五模式表达与当前评价契约

任务模式描述输出要求；本轮情绪 cue 描述相处方式，两者可以共存。不能看到“报错”就丢掉明确的难过，也不能看到引文中的“难过”就把一个代码任务变成安慰聊天。

| 模式 | 允许的情绪影响 | 必须保持 |
| --- | --- | --- |
| chat | 有证据的方向、克制的牵挂、熟悉程度和玩笑节奏 | 不报告数值、不编经历、不用关系压力要求回应 |
| support | 关注对方眼前难处；可以使用与该求助相关的情绪方向 | 不让角色自己的委屈、吃味或联系需求抢走支持焦点；少分析用户心理 |
| task | 可有简短的关心、耐心与语气余温，不插入角色情绪独白 | 正确性、完整步骤、事实、数字、代码与用户指定的详细程度 |
| creative | 服务于用户指定的作品、叙述视角与情绪 | 不强制只准正向情绪；不把虚构叙述变成角色的真实共同经历或主人事实 |
| structured | 情绪不增加、删改或包围指定输出 | JSON/XML/CSV、逐字内容、代码、否定、引文和精确格式 |

明确格式优先。混合求助可携带支持 cue；判定时排除引文、假设、代码和他人台词。不能通过改模式绕过原有内容保护。150 token 是本项目状态段工程预算，使用实际 `estimateTokens` 验证，不按字数估计，也不将“少说”误作删减任务信息。

策略只读取当前 `source_message_id`、当前 owner、未删除原文与有效评价。后台模式本轮还没有评价就保持未知；前置模式超时继续任务，不借前一条消息填空。旧 `ValidatedAppraisal` 的 kind/intent 与新 `EmotionAppraisal` 的情境向量不同，不能直接强制类型转换。若需要适配，须有明确来源、版本、优先级和多评价选择规则，并验证不会重复结算关系。

N02 应分清：旧策略、连续表达、检索加成和最终守卫四条链。QQ 一条策略接线通过不代表桌面与主动消息都通过。检索若使用 PAD，需统一取值范围并保留旧记录回退；事实型查询仍保持零情绪加成，不能以新状态改变事实优先顺序。

## 4. PAD 的分阶段兼容

旧 Mood 为 anger/hurt/joy/tension/expressiveness，新 PAD 为三个轴。任意历史四种独立情绪再加 expressiveness，不能仅凭三轴承诺无损逆映射；“所有输入误差不超过 .05”没有成立的通用被测物。

1. **来源保全阶段**：继续保留旧情感事件与旧状态的重建能力；新 appraisal、回应账本、OCC 成分和 PAD 各有来源和参数版本。读投影不写增量，不把两个系统的同源贡献重复相加。
2. **消费方切换阶段**：逐项明确表达、策略、检索、主动候选使用哪种状态。新来源有效时使用约定的新投影；缺新评价的旧消息仍可回退。诊断同时说明所用来源，不能把 unknown 映成“情绪为零”。
3. **替换候选阶段**：若要替换旧 Mood，先定义带版本的兼容投影。需要保留旧信息时，从原事件／成分或明确的兼容基线生成旧字段，不能声称 PAD 本身保存了被丢弃的信息。新规则的误差比较必须指定语料、损失函数和允许差异，不混称向后兼容与模型质量等价。

每阶段验证相同目标时间、重复读取、倒退时钟、迟到／修订／删除、重启、导入和合并后的重放一致。迁移只追加，008 原文保持不变。便携文件增加语义时检查旧读取器行为，必要时显式提高读取版本；不得让旧版静默丢失新状态。回退保留一致性备份和升级后新消息，不直接把新库交给旧程序。

## 5. 关系、驱力和调节：本轮提案边界

`contact` 已是工程联系驱力；它不是人物承诺、同意、性欲或用户有义务回复的证明。intimacy、desire、passion 与 commitment 不凭字段名称获得心理测量意义。本轮不直接把 `familiarity` 改名 intimacy，也不把所有 liking 或 appealingness 等价为 desire。

P2 接口、持久化形式、参数和同步版本仍待双方确认。本轮提案只限定行为：慢关系与短时驱力分开；新证据绑定当前消息和 owner；没有相关证据时允许未知或不激活；沉默、休息、离线、正常社交不扣信任，不产生亲密同意。commitment 暂留未定，不从日常闲聊自动累积，也不为了凑三轴虚构承诺。

Baumeister 与 Bratslavsky 的论文提出 intimacy 变化与 passion 的理论联系；出版商摘要描述的是 intimacy 上升，并明确证据不足以定论。它不支持本项目将 `abs(d intimacy / dt)` 直接作为正向激情增益。拒绝“亲密度下降同样必须提高浪漫／性驱力”的旧验收建议；负向变化可有另行、有证据的失落或紧张，不能因此奖励伤害。以上是对来源范围的限制，不是宣称已经确定了唯一正确的 passion 方程。[出版商摘要](https://journals.sagepub.com/doi/abs/10.1207/s15327957pspr0301_3)

调节阈值 .7/.5/.75、时间常数 6 小时、缓解比例 .35、任何 longing 上限系数都属于待校准工程初值，本轮核对的文献不能为其给出数值依据。高 arousal 可能来自高兴或任务兴奋，不能仅凭一个阈值把所有回复降格或阻止合理表达。调节应产生可测试的计划约束，最终守卫仍检查关系压力、事实与格式；不对代码、引文或结构化值做盲目禁词删除。

## 6. 文献校正与阅读范围

| 来源 | 本轮核到的范围 | 可用于本规格的结论与限制 |
| --- | --- | --- |
| [W3C EmotionML OCC 词表](https://www.w3.org/TR/emotion-voc/#occ-categories) | 官方词表 | 22 项含 happy-for、gratification，不把 envy、jealousy 塞进该 22 项；7 个中文显示词不另增为 7 个独立 OCC 类别 |
| [Scherer 2009](https://pmc.ncbi.nlm.nih.gov/articles/PMC2781886/) | 原文页面与 SEC 相关段落 | 承载论文是 2009，引用早期 SEC 时区分被转述的 Scherer 2001；不拿此文证明项目的固定系数 |
| [Gebhard 2005 ALMA](https://www.dfki.de/en/web/research/projects-and-publications/publication/1782/) | 作者机构条目与摘要 | 支持分层设计参考；不等于读完全文或复现其全部算法 |
| [Barrett 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5390700/) | 原文书目信息与摘要 | DOI 为 10.1093/scan/nsw154；旧 PMC12164598 不是这篇 2017 原文，不用它冒充对应来源 |
| [Sternberg 1986](https://pzacad.pitzer.edu/~dmoore/psych199/1986_sternberg_trianglelove.pdf) | 原论文开篇定义 | 三角理论中的三个概念可供设计参考；没有给出本插件的参数或把 passion 严格等同 desire 的公式 |
| [Diamond 2003](https://pubmed.ncbi.nlm.nih.gov/12529061/) | 原论文 PubMed 检索摘要；页面打开受验证限制 | 摘要区分欲望与依恋系统并描述双向联系；不能推出数字上互不影响或唯一计算公式 |
| [Baumeister 与 Bratslavsky 1999](https://journals.sagepub.com/doi/abs/10.1207/s15327957pspr0301_3) | 出版商摘要 | 理论假设而非充分证实的定律；不支持绝对导数验收 |
| [Gross 1998](https://doi.org/10.1037/1089-2680.2.3.271) | 出版商书目信息／检索摘要；正文访问未完成 | 替换旧主题页链接，不能以“已阅读全文”或本项目的阈值来自此文作背书 |

PAD 的工程坐标、中文显示词阈值和项目放行线均需单独登记来源。[中文词表](CHINESE_EMOTION_LEXICON.md) 区分词义、场景证据和数值阈值。Bowlby/Ainsworth 等作者名本身不构成可执行规格；若后续实施依恋或承诺模型，另附准确原始书目、实际阅读范围与接口，不以补一个引用代替验收。

## 7. 验证、发布与未测项

下列命令在源码整合树执行，Node >=22.13，先构建再测试；它们是执行方式，不代表本文件已经运行了所有命令：

```powershell
node scripts/build.mjs --check-only
node scripts/build.mjs
node --test tests/unit/continuous-emotion.test.mjs tests/integration/continuous-affect.test.mjs tests/integration/emotion-evaluation.test.mjs tests/integration/emotion-withdrawal.test.mjs tests/integration/continuous-portable.test.mjs
node --test "tests/**/*.test.mjs"
node scripts/replay.mjs --turns 10000
node scripts/replay-continuous.mjs
node scripts/replay-proactive.mjs
```

本轮新增用例必须覆盖实际消费者及发送前行为；纯函数、worker 状态或 HTTP 200 不能代替真实装配。模型自然度、误杀率、真实成本和延迟使用同一模型及固定材料，按 [人评表](HUMAN_EVALUATION.md) 单列。界面实际操作、真实 QQ 到达、另一台物理电脑接收、跨应用长期感知和至少七天自愿体验仍按未测记录，不能由两份隔离数据库代签。

每个工作包交付提交、文件、测试输入与结果、未测项、兼容／配置影响及回退方式。已验证的本机云端合并不推导出另一台电脑已升级。夜间收尾按主人授权停止接新任务、保存证据、确认记忆上传回读、推送已验证的插件代码；生产数据、凭据、原图与本机授权不进 Git。收尾动作的实际成功由执行日志证明，本文不预先宣称已上传、已推送或已关机。
