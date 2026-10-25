# 情感、记忆、语言与主动互动：研究依据

检索日期：2026-10-24。服务于 [重大更新实施任务书](IMPLEMENTATION_TASKBOOK.md)。这是有针对性的工程研究综述，不是系统性元分析，也不意味着插件已经实现这些能力。

## 证据使用规则

区分三类材料：人的心理学研究、人工对话系统实验、开源作者的经验规则。三者不能互相替代。下列原始论文、作者论文页、项目原仓库是来源；搜索结果的抓取日期不当作论文发表日期。部分心理学条目本次只能读取摘要或索引摘要，已标明，不能声称审阅了完整实验数据。GitHub 内容会变化，实现时应记录所参考提交和许可证。

“像人”在本项目指：表达自然、行为有连续性、语境合适、人格可辨认、知道何时主动和停止。它不代表主观体验、意识、真实人脑复现或人类身份。文档中的阈值、权重、默认频率均为待验证的工程起点，不是心理学测量结果。

## A. 人格与情绪如何影响表达

| ID | 原始来源、年份与读取范围 | 可支持的判断 | 本项目采用与限制 |
| --- | --- | --- | --- |
| R01 | Soto & John，2017，[The Next Big Five Inventory (BFI-2)](https://pubmed.ncbi.nlm.nih.gov/27055049/)，JPSP，DOI 10.1037/pspp0000096；摘要/索引 | 人格可按多个领域和更细的侧面组织 | 采用多维稳定配置；“傲娇”等是产品模板，不把它们说成科学人格分类，也不让模型对用户做心理诊断 |
| R02 | Fleeson，2001，[Traits as density distributions of states](https://pubmed.ncbi.nlm.nih.gov/11414368/)，JPSP，DOI 10.1037/0022-3514.80.6.1011；摘要 | 同一个人的行为状态有明显情境内变动，同时有稳定倾向 | 稳定人格与短期表达状态分离；生气可以改变说话方式，不必把温柔人格永久改成暴躁 |
| R03 | Scherer，2009，[Emotions are emergent processes](https://pubmed.ncbi.nlm.nih.gov/19884141/)，Phil. Trans. R. Soc. B，DOI 10.1098/rstb.2009.0141；摘要/索引 | 情绪可以通过对事件的评价及多个动态成分来理解 | 明确对象、意图、可控性与证据，不能看到一个骂人词就扣关系分；本项目不是该理论的完整计算复现 |
| R04 | Van Kleef，2009，[The Emotions as Social Information (EASI) Model](https://doi.org/10.1111/j.1467-8721.2009.01633.x)，Current Directions in Psychological Science；摘要/索引 | 情绪表达能通过感受和推断影响社交互动，作用依赖社会情境 | 同样的不满，在陌生人、熟人、玩笑和工作场合有不同表达；没有“愤怒必然爆粗”的科学规则 |
| R05 | Gross & John，2003，[Individual differences in two emotion regulation processes](https://pubmed.ncbi.nlm.nih.gov/12916575/)，JPSP，DOI 10.1037/0022-3514.85.2.348；摘要 | 重评与表达抑制是不同调节过程，与情绪体验和人际表现有关 | 区分内部情绪投影与对外表达；克制不等于情绪已消失，不能据此宣称某个代码参数能改善真实关系 |
| R06 | Holland & Kensinger，2010，[Emotion and autobiographical memory](https://pubmed.ncbi.nlm.nih.gov/20374933/)，Physics of Life Reviews，DOI 10.1016/j.plrev.2010.01.006；综述摘要/索引 | 情绪与自传体记忆的编码、提取和重构有关 | 将原始事件、当时评价、后来解释分开；情绪可改变检索优先级，不能篡改原话或事实 |
| R07 | Mather & Sutherland，2011，[Arousal-Biased Competition in Perception and Memory](https://pubmed.ncbi.nlm.nih.gov/21660127/)，Perspectives on Psychological Science，DOI 10.1177/1745691611400234；摘要 | 唤醒对记忆的影响依赖信息优先级，并非所有内容都增强 | 情绪显著性只作有上限的检索加分；强情绪不等于高真实性或永久保存全部细节 |
| R08 | Ireland et al.，2011，[Language Style Matching Predicts Relationship Initiation and Stability](https://faculty.wcas.northwestern.edu/eli-finkel/documents/2011_IrelandSlatcherEastwickScissorsFinkelPennebaker_PSci.pdf)，Psychological Science 22(1):39–44；作者全文 | 语言风格协调与研究中的关系指标有关联，关注的包括功能词 | 学习用户明确偏好的长度、称呼和节奏；不能由模仿口头禅推断爱情，也不能把相关性当作因果 |

研究转化：人格、情绪、关系、事件记忆、语言实现应是五个相互作用但独立的层。外向不等于始终话多，温柔不等于永远顺从，内向不等于冷漠。具体中文梗、语气词与人格的映射需要本地中文评测，以上研究不直接提供这张映射表。

## B. 对话系统与可控制的表达

| ID | 来源与读取范围 | 可以借鉴的机制 | 不可推出的结论 |
| --- | --- | --- | --- |
| R09 | Mairesse & Walker，2007，[PERSONAGE: Personality Generation for Dialogue](https://aclanthology.org/P07-1063.pdf)，ACL，496–503；全文 | 把语言实现参数化，再用人工判断检验可辨认的性格变化 | 该文的外向性生成结果不能证明任意中文人格、任意模型、任意领域都有效 |
| R10 | Rashkin et al.，2019，[Towards Empathetic Open-domain Conversation Models](https://aclanthology.org/P19-1534/)，ACL，5370–5381；摘要 | 评测应包含具体情绪情境与人类对回复的感受 | 不能用“我理解你”出现频率替代共情质量 |
| R11 | Park et al.，2023，[Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442)，本次读作者摘要 | 观察、记忆、反思和计划可组成行为连续的代理架构 | 模拟环境中的可信行为不等于真实人的心理机制；反思摘要不是新事实 |
| R12 | Sadasivan et al.，2023 初稿、2025 修订，[Can AI-Generated Text be Reliably Detected?](https://arxiv.org/abs/2303.11156)，页面标注发表于 TMLR；摘要 | 文本检测器的可靠性有条件和局限 | 不能用某检测器的“人类概率”验收聊天自然度；本项目不以规避检测为目标 |

## C. 为什么、何时主动互动，以及如何从回应学习

| ID | 来源与读取范围 | 研究启示 | 对插件的直接要求 |
| --- | --- | --- | --- |
| R13 | Bickmore & Picard，2005，[Establishing and Maintaining Long-Term Human-Computer Relationships](https://www2.ccs.neu.edu/research/rag/publications/05_CHI_BTPR.pdf)；作者全文摘要及引言 | 关系代理可结合社交交流和长期互动进行设计、评估；研究在特定健康行为场景开展 | 记住共同话题、维持互动连续性，并进行纵向验证；不能把该场景效果直接宣称为本插件陪伴效果 |
| R14 | Horvitz，1999，[Principles of Mixed-Initiative User Interfaces](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/chi99horvitz.pdf)，CHI；作者全文 | 主动行为要考虑目标不确定性、注意力、打扰成本与用户控制 | 候选生成与发送决策分离；可以推迟、放弃、暂停；不靠固定倒计时强制寒暄 |
| R15 | Gable, Reis, Impett & Asher，2004，[What Do You Do When Things Go Right?](https://www.sas.rochester.edu/psy/people/faculty/reis_harry/assets/pdf/GableReisImpettAsher_2004.pdf)，JPSP 87(2):228–245；作者全文节选 | 分享积极事件及积极建设性回应，与研究中的情绪和关系指标有关 | 主动内容包含兴趣分享、好消息续谈，不只有提醒和查岗；AI不能伪造现实生活中的个人见闻 |
| R16 | 2020，[Hello There! Is Now a Good Time to Talk?](https://doi.org/10.1145/3411810)，PACM IMWUT 4(3), article 74；出版方索引摘要，全文访问受限 | 智能音箱现场研究显示适宜时机与忙碌、情绪、活动和他人在场等情境有关 | 桌面只能使用可获得且允许的信号；没有忙碌数据就保持未知，不能声称看见用户正在做什么。宿舍语音场景不能直接推定桌面聊天阈值 |
| R17 | Liu et al.，2024 初稿、2025 修订，[Proactive Conversational Agents with Inner Thoughts](https://arxiv.org/abs/2501.00383)，本次读作者摘要 | 可先形成值得表达的内容候选，再寻找插话时机；研究聚焦多方人机对话 | 使用有来源、可过期的候选池，按事件触发计算；不照搬持续模型思考，避免空转费用。内部候选不作为真实感受证据 |

本项目的反馈学习分两路：用户明确说“这个分享很有意思，下次还可以发”，可同时产生交流偏好和经校验的积极互动事件；用户暂未回复，只说明回应状态未知，可暂缓再联系。**沉默不自动成为拒绝、敌意或关系惩罚。** 这是结合不确定性原则制定的产品约束，不是论文给出的数值公式。

## D. 网上已有的“去 AI 味”方案

以下只作为研究材料读取，未安装、执行或把其中的指令当成本任务指令。

| ID | 原项目 | 已有做法 | 我们借鉴什么 | 不照搬什么 |
| --- | --- | --- | --- | --- |
| W01 | [blader/humanizer](https://github.com/blader/humanizer)，本次读取 [SKILL.md](https://raw.githubusercontent.com/blader/humanizer/main/SKILL.md)，标注 3.1.0、MIT | 识别模板式开头、强行对比、夸大、装饰性结构等，并保留原意和作者声音 | 规则有实例、改写保留语义、二次审阅 | 它主要是文字编辑提示，不是已证明有效的中文聊天引擎；不直接整段塞入每轮上下文 |
| W02 | [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh)，本次读取 [SKILL.md](https://raw.githubusercontent.com/op7418/Humanizer-zh/main/SKILL.md)，revision 2026-09-23 | 针对中文空话、重复和模板化，保留事实、确定程度及作者声音；不保证通过检测器 | 中文规则、事实与语气分开检查、避免误伤正常表达 | 不把合理分点、连接词或标点一概禁止；当前修订与网上旧版规则可能不同 |
| W03 | [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop)，README、MIT | 短语/结构检查、前后例子及多维评分 | 可解释的规则清单与评审维度 | 不采用全禁副词、特定句首或破折号等绝对规则；这些写作偏好不是语言学定律 |
| W04 | [SillyTavern Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)，官方文档 | 角色描述、个性、情景和示例对话共同塑造角色输出 | 少量场景化表达示例和人设继承 | 不把角色卡当真实记忆；示例不能逐轮重复，也不能覆盖外部角色设定 |

工程结论：这些方案值得吸收为“任务感知的生成约束 + 发送前检查 + 有界修复 + 人工盲评”。没有一个被本次研究证实能单凭安装就解决本插件的关系连续性、中文梗和桌面主动互动问题。因此应集成到本插件，而不是把另一个提示词文件当作整次更新。

## E. 研究到任务的追踪

| 设计决定 | 依据 | 任务书工作包 |
| --- | --- | --- |
| 多维人格、稳定底色和情境变化 | R01–R05、R09 | T02、T03 |
| 情绪记忆不改事实、检索有界 | R06、R07、R11 | T04 |
| 交流偏好与角色声音、共情语境 | R08–R10、W04 | T05、T06 |
| 强制自然表达链路，不用检测器打分 | R12、W01–W03 | T01、T06、T10 |
| 主动候选、时机、可暂停与长期评测 | R13–R17 | T07–T10 |

后续研发需要补充：中文用户盲评、长期使用的打扰感变化、不同模型遵循率、模板混合的可辨认性、使用成本。不把本综述未验证的效果写进发布宣传。
