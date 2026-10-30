# 主动开口（idle talk）

## 为什么加这一条

主动消息原本只有五个候选来源，任何一个都不负责「就是隔了很久，主动找主人说句话」：

| 来源 | 触发条件 | 常态结果 |
| --- | --- | --- |
| `reminder` | `tasks` 里有 confirmed 且到期的提醒 | 从不产生（任务表为空） |
| `follow_up` / `positive_revisit` / `shared_topic` | 入站消息命中三条固定正则（面试/考试、通过/获奖、回头再聊） | 日常对话几乎不命中 |
| `interest_share` | 配置了 `proactive.shareSources` 的 HTTPS RSS 源 | 默认空数组 |
| `computer_event` | `computerEvents.enabled` 或 `perception.enabled` 为真 | 默认关闭 |
| `repair` | 有未结冲突 episode 且 `grievance ≥ .35` | 不满值通常远低于阈值 |

原来的 `smallTalkCandidate` 名字像闲聊，实际只是把上面这些已存在的 pending opportunity 再筛一遍，本身不产生候选。
结果是：调度器每 5 分钟扫一次，每次都是 `no-candidate`，一条主动消息也发不出去。

## 现在的行为

`idleTalkCandidate`（`src/proactive/candidate-builder.ts`）在**全部硬闸门通过之后**追加一条 `small_talk` 候选：

- 取本会话最后一条 `role='user'` 且未删除的原文作锚点；
- 距这条原文超过 `proactive.idleTalkMinutes`（默认 150 分钟）才成立；
- 分数 `relevance .55 / openness .5 / interruption .3`，仍要过 `opportunityThreshold`（默认 .35）；
- key 为 `small_talk:<会话>:<原文seq>:<空闲窗口序号>`，同一窗口只入队一次，跨窗口才再候选。

锚点只用真实原文，不编造新事件；生成侧（`generateProactive`）沿用原有「一句话到两句话、不解释为什么说话」的要求。

## 仍然生效的闸门

静默时段（`quietStart`/`quietEnd`，默认 23:00–08:30）、日限额（`spontaneousLimitPerDay`，默认 2）、
冷却（`spontaneousMinGapMinutes`，默认 180）、发出未回暂停（`pauseAfterUnanswered`，默认 1）、
设备归属、主回合在跑、表达式守卫，全部照旧。

## 配置

```yaml
proactive:
  enabled: true
  idleTalkMinutes: 150   # 设为 0 关闭这条路径
```

## 验证

```sh
node scripts/build.mjs
node --test "tests/integration/proactive-idle-talk.test.mjs"
```

用例覆盖：未到阈值不产生候选、到阈值选中 `small_talk` 且锚点来自真实原文、已删除原文不能当锚点、
同一窗口只入队一次且回复后才在下一窗口再候选、静默时段仍然挡住。
