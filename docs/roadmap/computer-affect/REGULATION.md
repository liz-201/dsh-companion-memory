# 表达调节层（regulation）实现说明

对应 `src/expression/regulation.ts`、`tests/unit/expression-regulation.test.mjs`，以及 `src/expression/policy.ts` 的一处文案改动。

## 1. 函数契约

```ts
export function regulateExpression(plan: ExpressionPlan): ExpressionPlan
```

- **纯函数**：不读时间、不读随机、不调模型、不查数据库；同一输入两次调用结果深度相等。
- **输入不变**：返回 `{ ...plan, reasonCodes: [...plan.reasonCodes] }`，入参对象与其数组都不被写。
- **只动表达层**：允许改 `stance`、`playfulness`、`allowedMemeIds`、`directness`（仅在确认为 firm 时抬到 0.6）与 `reasonCodes`。
- **不碰**：`requiredFacts`、`sourceIds`、`protectedSpans`、`targetSentences`、格式/代码/数字。事实正文与引用原样透传。
- **不增加主动联系频率**：本函数不产生任何联系动作，也不放大句数上限；`targetSentences` 永远与输入相同。
- `plan.continuous` 当前类型里没有 `relationship`，因此按可选结构安全读取（`{ intimacy?, desire?, passion? }`），非数字一律当 0，不拓宽 `ExpressionPlan` 类型。

## 2. 阈值（工程初值，不是实证常数）

```ts
export const REGULATION_THRESHOLDS = { impulse: .6, firm: .7, joy: .6, desire: .7 }
```

这四个数字只用来让规则可检查、可调整，不对应任何心理学量表坐标。改动它们只需要改这一处，测试会跟着断言边界。

## 3. 规则表

情绪证据一律取自 `plan.continuous.emotions`（`EmotionComponent[]`，category + intensity），不解析用户原话。

| 条件 | 动作 | reasonCode |
|---|---|---|
| `mode === 'structured'` | 原样返回，连 reasonCode 都不加 | 无 |
| 无情绪证据 | 不做判断，只留痕 | `regulate:no-emotion-evidence` |
| `mode === 'support'` | `stance = supportive`，`playfulness = 0`，`allowedMemeIds` 不动 | `regulate:support-focus` |
| anger 族（anger/reproach/resentment/hate）≥ .6 | `playfulness = 0`、`allowedMemeIds = []`；≥ .7 时 `stance = firm` 且 `directness ≥ .6` | `regulate:impulse-contained` |
| joy 族 ≥ .6 且 anger < .6 | 保留原 `playfulness`；若 `stance` 是 firm 则降为 interested | `regulate:joy-preserved` |
| pain 族（fear/fears-confirmed/distress/disappointment/shame/remorse）≥ .6 且 anger < .6 | 不改强度，只保证不升级；若 `stance` 是 firm 则降为 guarded（support 下为 supportive） | `regulate:fear-not-firm` |
| `max(desire, passion) ≥ .7` | 不做任何表达扩张，只留痕 | `regulate:no-consent-inference` |

`reasonCodes` 去重后追加，所以重复调节同一份 plan 不会堆重复码，二次调用与原调用深度相等。

## 4. 几条为什么这样分

- **只有 anger 族能升到 firm**。firm 是「对对方表达不满」，恐惧、悲伤、失望都不构成对对方的指认。pain 族即使强度很高，也只降语气温度，绝不升格成惩罚。
- **高唤醒不等于高冲动**。PAD `arousal` 高既可能是愤怒也可能是兴奋，所以 joy 规则根本不看 arousal：只要 joy 族 ≥ .6 且没有 anger 族证据，`playfulness` 原样保留。若某处因 arousal 把 plan 设成 firm，这里会把它降回 interested。
- **support 不抢戏**。support 下即使有 anger 证据也不升 firm、不清 `allowedMemeIds`（那些是主人自己的资源位，不由调节层处置），只保证 `stance` 是 supportive、不开玩笑。
- **desire / passion 不是同意**。这两个值高只能说明状态强，不能推出关系承诺、身体许可或「该更主动」。所以规则只写 reasonCode，不改任何表达强度，也不动 `targetSentences`。
- **structured 直通**。逐字复述与格式契约的场景里，任何情绪指令都会污染输出，所以这条路径连 reasonCode 都不加，`deepEqual(regulateExpression(plan), plan)` 成立。

## 5. 与 policy.ts 的分工

- `policy.ts` 负责「说什么话」：`MODE_EMOTION_LINES` 决定每个模式注入几条连续情绪句，`renderPlan` 负责 150 token 预算内的拼装。
- `regulation.ts` 负责「允许多大的劲」：stance、玩笑额度、meme 白名单。
- 本次同时把 task 模式的低接触分支从「只答正事，不加寒暄。」改成「先把具体事情讲清楚，语气自然。」——原来的写法容易被读成冷淡和截断详解，新写法保持任务优先但不砍内容。

## 6. 接线状态

`regulateExpression` 目前**没有被任何 runtime 调用**，由 Codex 负责接入 `src/expression/runtime.ts` 的 plan 生成之后、渲染之前。本包不含接线代码，也不改 runtime、domain、storage、portable 与版本号。

## 7. 边界回归（11 项，全绿）

1. 返回副本、入参不被写、`reasonCodes` 是新数组且前缀保留。
2. structured 直通：富负面状态与无状态深度相等，且不加 reasonCode。
3. 高唤醒喜悦保留：arousal .95 + joy .8 → `playfulness` 不变、stance 不为 firm。
4. 恐惧不转惩罚：fear .9 + distress .85 且 stance 被设成 firm → 输出不是 firm。
5. anger .8 限制玩笑但保留 `requiredFacts` / `sourceIds`，stance 升 firm。
6. anger .3 不限制玩笑、不升 firm、不加码。
7. support 下 anger .9 仍然 `supportive` 且 `playfulness = 0`。
8. 高 passion 不改 `targetSentences`、不改 meme 白名单，只留 `no-consent-inference`。
9. 事实正文与 `protectedSpans` 原样。
10. 确定性与幂等：两次调用深度相等，二次调节不再变化。
11. 新增 reasonCode 全部以 `regulate:` 开头；阈值都在 (0,1) 区间。
