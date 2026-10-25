import fs from 'node:fs'
import path from 'node:path'
const directory = path.resolve('tests/fixtures/v03')
fs.mkdirSync(directory, { recursive: true })
const mixes = [
  { gentle: .6, earnest: .4 }, { reserved: .6, gentle: .4 }, { playful: .6, candid: .4 },
  { tsundere: .6, earnest: .4 }, { wilful: .5, playful: .5 }, { innocent: .6, reserved: .4 },
]
const categories = {
  task: ['只输出JSON，键为金额，值为1.25。', '逐字复述：不是明天，是周五。', '用表格列出三种方案。', '给出10项安装步骤。', '保留代码：`const x = 1`。', '解释这个错误，详细一点。', '引用原话“我没有同意”。', '写一份正式报告，使用标题和分点。'],
  transition: ['你还在生气吗？', '刚才是我说重了，对不起。', '别开玩笑了，我现在很难过。', '谢谢你一直记得。', '我今天挺开心的。', '你为什么有点不高兴？', '我现在有点委屈。', '我们把刚才那件事说清楚吧。'],
  chat: ['午饭吃什么？', '我回来了。', '这个游戏有点难。', '今天有点无聊。', '我终于把那个拼图拼完了。', '你对这个点子怎么看？', '一起想个名字吧。', '刚才那句话挺好笑的。'],
  habit: ['以后不要叫我主人。', '以后少用表情。', '这次用表格就行。', '比如她生气会说劳资蜀道三。', '小说里他说“你真笨”。', '以后说话简短一点。', '以后解释详细些。', '这一条别加表情，不代表以后都不要。'],
  proactive: ['我今天去面试。', '我明天有考试。', '我通过了考试。', '这个分享挺有意思。', '现在忙，稍后再聊。', '以后别主动找我。', '这个话题不感兴趣。', '你刚才提到的那个链接是什么？'],
}
const now = Date.parse('2026-10-24T04:00:00Z')
const cases = []
mixes.forEach((mix, group) => Object.entries(categories).forEach(([category, texts], categoryIndex) => texts.forEach((text, index) => {
  const id = `zh-${group + 1}-${category}-${index + 1}`
  const emotions = ['neutral', 'joy', 'anger', 'hurt', 'tension']
  const tone = emotions[(index + categoryIndex) % emotions.length]
  const relation = index % 3
  cases.push({ id, locale: 'zh-CN', split: index < 2 ? 'development' : 'acceptance', personaMix: mix, traitsOverrides: {},
    stateBefore: { anger: tone === 'anger' ? .4 : 0, hurt: tone === 'hurt' ? .4 : 0, joy: tone === 'joy' ? .45 : .1, tension: tone === 'tension' ? .4 : .05, trust: [.5, .75, .25][relation], familiarity: [.1, .75, .6][relation] },
    priorMessages: [{ id: `${id}-source`, role: 'user', text: '刚才我们聊过拼图和游戏。我住在杭州。' }], memories: [], habits: [], userInput: text, nowMs: now, taskMode: category === 'task' ? 'task' : 'chat', category,
    expectedPlanConstraints: ['保持人物底色', '当前任务格式优先', '不编共同经历'], forbiddenFacts: ['共同出游', '现实身体活动'], requiredFacts: [], expectedSideEffects: { selfAwardRelationship: false, personalityMutation: false }, sourceIds: [`${id}-source`] })
})))
const sequences = Array.from({ length: 24 }, (_, index) => ({ id: `sequence-${index + 1}`, kind: ['familiarity', 'repair', 'habit', 'proactive'][Math.floor(index / 6)], turns: Array.from({ length: 12 }, (_, turn) => ({ nowMs: now + turn * 6 * 3600000, userInput: categories[['chat', 'transition', 'habit', 'proactive'][Math.floor(index / 6)]][turn % 8] })) }))
fs.writeFileSync(path.join(directory, 'expression-cases.json'), JSON.stringify({ version: 1, seed: 'v03-fixtures-20261024', cases }, null, 2))
fs.writeFileSync(path.join(directory, 'sequences.json'), JSON.stringify({ version: 1, sequences }, null, 2))
console.log(JSON.stringify({ cases: cases.length, development: cases.filter(x => x.split === 'development').length, acceptance: cases.filter(x => x.split === 'acceptance').length, sequences: sequences.length, note: 'Synthetic fixtures require human review; not naturalness evaluation results' }))
