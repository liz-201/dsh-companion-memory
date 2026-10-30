# 情感评价字段抽取修复（2026-10-30）

本次调整观察器契约与主人陪伴意愿的证据门槛，不改 schema、迁移、分类阈值或生产数据。适用于后续实际执行的观察器抽取；仅修改提示词不代表真实模型必定遵守，仍需部署后由主线程核对实际抽取分布。

有证据时，object 填 appealingness；action 填 praiseworthiness 和 agency；event 填 affectedParty，并按结果归属填 desirability（角色自身）或 desirabilityForOther（主人/他人）。对他人的关切 likingForOther 和应得性 deservingness 也必须各有依据。未知仍省略，允许保留稀疏评价；解析器不拒绝旧的稀疏记录，分类器不把缺失字段补成情绪。

pull 接受“喜欢和你聊天”“想你了”“多陪我一会”等直接陪伴意愿；仍须模型提供 pull、置信度达标、私聊且来源证据合格。工作语境排除改为检查整条来源，防止模型选取其中短句绕过限制。引用、假设、第三方、拒绝边界继续排除。appealingness 不自动生成 pull。

## 历史记录处理

本次不自动重新抽取已有的 39 条评价，不添加数据迁移，也不读取生产库。重放只用已存 vector 重新分类和投影，不能恢复从未提取的 appealingness、praiseworthiness 或 pull。历史已存 pull 会在重放时使用新门槛重新资格审查；历史缺失 pull 仍然缺失。

若之后决定修复历史，应先在隔离副本上按原始消息重新执行观察器，校验 source/quote/owner，并通过现有 saveEmotionAppraisals 修订同一 source 的槽位、保留修订历史；不能直接向量补值或重复追加情绪。现有 requestObservation 有消息内容签名去重，因此普通重放或重复请求不会自动重新抽取旧消息。批量强制重抽工具及生产回填不在本次范围。

## 验证边界

新增集成测试经真实 TurnCoordinator 的入站、观察器请求、协议解析、SQLite 保存和 continuousAffect 投影，逐 focus 覆盖完整字段与关键字段缺失，并覆盖他人结果、应得性、中文显示、陪伴意愿及拒绝条件。模型使用确定性替身；这些测试证明链路与契约传递，不证明线上模型字段召回率，也不证明部署生效。

在 HEAD e2cfda1 的独立源码快照上构建通过。新增定向测试 23/23 通过；全量回归 679 项中 674 通过、0 失败、5 项因缺少 Desktop runtime 测试材料跳过。008 迁移校验和仍为 3158aaa4fd3d5dc4e7dd8e37c59135cb。
