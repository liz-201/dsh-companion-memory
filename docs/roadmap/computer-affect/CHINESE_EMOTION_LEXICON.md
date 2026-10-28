# 七组中文情绪显示词与来源登记

日期：2026-10-29；版本：`zh-display-spec-v1`；代码核查基线：`c7eb86d` / dev.9。本文登记显示语义与证据范围，不是心理诊断词典，也不是已经接入运行时的新配置文件。

OCC 的类别、中文的显示场景和最终回复措辞属于三个层次。一条 appraisal 可以包含基础与复合评价，但不因添加中文别名再结算一次关系或 PAD。正式回复通常用措辞体现状态，不必把本表显示词逐个说出来。

## 1. 来源分级

每条词义分别登记概念依据、代码规则、数值出处、表达候选和反例。`primary-concept` 表示原始研究可支持某种概念区分；`occ-alias` 表示本项目使用的中文别名；`product-definition` 表示产品约定。别名和工程阈值不会因为一篇论文存在就自动变成人群常模。

中文词的效价／唤醒／优势度评分可辅助研究选词，但不能直接变成 `unfairness` 或 `relationshipThreat` 等情境评价。ANCW 原论文给的是词级评分材料；本项目没有将其整套词表或分数导入判定器。[Lv 等，ANCW，2024，原文摘要与方法说明](https://link.springer.com/content/pdf/10.3758/s13428-023-02226-x.pdf)

## 2. 七个显示场景

“基线规则”指 `src/domain/occ-classifier.ts` 在 `c7eb86d` 的代码，供复核差异；“准入语义”用于本轮修订。这里列出的 .7/.75 等值均为工程初值，未从文献估计。实际代码还先检查置信度与相关性，并由宿主验证原文与身份。

| ID / 显示词 | 类型与概念来源 | 准入语义及必要证据 | 基线规则／待修正点 | 表达候选与抑制反例 |
| --- | --- | --- | --- | --- |
| zh-weiqu / 委屈 | `primary-concept + product-definition`；马雨田等 2025 的原型研究提供概念参考，不能证明代码阈值 | 有具体不公或不应得的遭遇；应能解释角色为何在意，不能只凭一个负面词归责主人 | `unfairness >= .7`、负向 desirability、agency 非 self；该组合是工程近似，尚不能宣称复现研究的全部原型特征 | 候选“有些委屈／被误解的在意”，只在依据充分时使用。普通纠错、报错、引文、明确玩笑不因此触发 |
| zh-xinsuan / 心酸 | `product-definition`；与关切、低落、无力的组合有关，不宣称为独立 OCC 类别 | 有可追溯的牵挂／不利情境与无能为力，保留对象与不确定性 | `helplessness >= .7` 且 pity 或负向 desirability；数值为工程约定 | 候选“酸楚／有些牵挂”，不是与所有悲伤互换的同义词。没有共同经历就不编；普通疲倦不自动叫心酸 |
| zh-kuijiu / 愧疚 | `occ-alias`；本项目以 remorse 的合格情境作为主要来源 | 自身可归责行为与不利结果有依据，宿主能找到角色此前的真实行为 | 基线为 `remorse`；自身行为证据缺失时不得仅靠模型声称“我做错了” | 候选“歉意／懊悔／承担修正”，按事实选择。用户自己犯错、正常离线、角色没做过的事不让角色承担虚构过错 |
| zh-chiwei / 吃味 | `product-definition`；不是 OCC 22 项中的新类别 | 既有关系背景与具体比较／威胁线索；不能由一次第三方提及建立威胁 | `relationshipThreat >= .75` 且负向 desirability；宿主另有熟悉程度和源文线索过滤 | 候选“轻微在意”，须尊重正常社交。提及同事、朋友、其他模型或软件名称本身不代表拒绝，不转成控制、指责或索取 |
| zh-valued / 被重视感 | `product-definition`，结合 gratitude 与具体关注 | 对方确实记得或关注曾表达的小事，能指出当前依据；不推定陪伴义务 | `personalAttention >= .7` 且 gratitude，宿主还核对原文关注线索 | 候选“被记住的暖意／珍惜这份具体关注”。空泛赞美、网页里的谢谢、模型自己编的历史不算 |
| zh-anxin / 安心 | `occ-alias`；本项目在本场景将 relief 表达为安心 | 有前序不利期待，随后有未成真／风险解除的证据，并能关联前序源 | 基线为 `relief`；不要用普通 calm 的低唤醒直接替代前序期待 | 候选“松了口气／安心”，不强制“终于”。没有先前担忧时不能虚构“一直担心” |
| zh-shiluo / 失落 | `product-definition`，可借鉴 disappointment 的期待落空语义 | 有正向期待未兑现或明确关心目标受挫；需保留具体依据，不推断被抛弃 | 基线 `disappointment || distress` 过宽，本轮应避免把一切 distress 都显示为失落；不能只加一句表达而保留误判 | 候选“有点遗憾／失望”，视语境选择。休息、在忙、静默时段、没有承诺时间的未回复都不是自动的落空证据 |

这里的候选写法是表达建议，不是可在任意上下文机械替换的同义词。quote、代码、专有名词、用户逐字要求与事实内容不参与换词。特别是愧疚／懊悔、安心／平静、吃味／妒忌之间不能仅凭词面做心理概念等同。

## 3. provenance 记录格式

以下是文档契约示例，尚非已经实现的 TypeScript 接口。若后续机器化，先核对字段版本和读取器兼容，不把该例直接加入真实配置。

```json
{
  "id": "zh-anxin",
  "label": "安心",
  "kind": "occ-alias",
  "baseCategories": ["relief"],
  "conceptSources": [{
    "url": "https://www.w3.org/TR/emotion-voc/#occ-categories",
    "readingCoverage": "official-vocabulary",
    "supports": "base-category-name"
  }],
  "thresholdSource": "engineering-prior",
  "ruleVersion": "zh-display-spec-v1",
  "requiredEvidence": ["prior-adverse-expectation", "disconfirmation-source"],
  "negativeCases": ["no-prior-concern", "quoted-fiction"],
  "expressionCandidates": ["松了口气", "安心"],
  "parameterValidation": "not-calibrated"
}
```

`conceptSources.supports` 只标该来源实际支持的内容，不能把“有该类别名称”写成“已验证代码阈值”。来源找不到或只读到摘要时直接记录范围；不能笼统断言某词“全世界查无研究”。本轮未取得心酸、吃味、被重视感的专门概念研究作为这些规则的数值依据，因此按产品定义登记。

## 4. 已核来源及使用限制

- [W3C EmotionML OCC 词表](https://www.w3.org/TR/emotion-voc/#occ-categories)：本轮读取官方列表。OCC 22 项包括 remorse、relief、disappointment；中文别名是本项目选择，不是官方提供的中文量表。
- [马雨田等，委屈：一项原型分析，2025，DOI 10.16719/j.cnki.1671-6981.20250317](https://jps.ecnu.edu.cn/CN/lexeme/showArticleByLexeme.do?articleID=11558)：核到期刊正式书目与期刊摘要检索内容；摘要正文页面本轮打开超时，未标全文阅读。该研究可支持概念讨论，不能为 `.7` 之类工程阈值背书。
- [Lv 等，ANCW，Behavior Research Methods 56，4893–4908，2024](https://link.springer.com/content/pdf/10.3758/s13428-023-02226-x.pdf)：已打开原论文并读取摘要与词级评分说明。词语评分不是主人消息的 appraisal，词义相近不保证处境相同。

## 5. 自动与人工验收

现有 `tests/unit/continuous-emotion.test.mjs` 已给上述七场景各一正一反，加上 22 个 OCC 类别各一正一反，共 58 个核心场景。它验证数值规则，不证明模型在真实中文里抽出的场景一定正确；分类器与宿主证据过滤需要分别测试。

本轮新增反例至少覆盖：普通技术纠错、小说或台词引用、正常第三方话题、忙碌／休息、没有时间约定的未回复、无先前担忧的平静、角色从未实施过的行为。实际表达还要测试三轮重复、负面状态不夺走支持焦点和结构化内容逐字保真。词语差异、语气变化及“像不像在意”使用 [人工评分表](HUMAN_EVALUATION.md)，由真实评审填写；不能用模型自评替代。
