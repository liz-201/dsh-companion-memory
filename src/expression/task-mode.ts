export type TaskMode = 'chat' | 'support' | 'task' | 'creative' | 'structured'

/** Verbatim and format contracts outrank every other signal. */
const STRUCTURED = /(?:只(?:能|要)?输出|返回|格式|生成).{0,16}(?:JSON|XML|CSV)|JSON\s*(?:格式|对象|数组)|逐字|原文|一字不改/i
const CREATIVE = /写(?:一篇|一段|一首|个故事|小说)|角色扮演|虚构|续写/
const TASK = /代码|报错|实现|插件|安装|排查|步骤|详细|方案|任务书|清单|表格|报告|计算|证明|教程|分析|怎么做/
/** First person plus an emotional word, so negation ("我不难过") and third-party reports do not match. */
const SELF_DISTRESS = /我(?:现在|今天|最近|真的|还是|也|有点|有些|特别|很|好|太|挺|都|快|真)*(?:难过|失落|伤心|害怕|焦虑|累坏|委屈|难受|烦|崩|撑不住)/
/** The emotional word is quoted, coded or being discussed as a word, so it is the topic and not the speaker's state. */
const META_CONTEXT = /[“”「」『』`]|比如|台词|引用|原文|这段(?:代码|正则|文本)/

export function taskMode(text: string): TaskMode {
  if (STRUCTURED.test(text)) return 'structured'
  if (CREATIVE.test(text)) return 'creative'
  if (SELF_DISTRESS.test(text) && !META_CONTEXT.test(text)) return 'support'
  if (TASK.test(text)) return 'task'
  return 'chat'
}
