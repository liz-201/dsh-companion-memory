export type TaskMode = 'chat' | 'support' | 'task' | 'creative' | 'structured'
export function taskMode(text: string): TaskMode {
  if (/(?:只(?:能|要)?输出|返回|格式|生成).{0,16}(?:JSON|XML|CSV)|JSON\s*(?:格式|对象|数组)|逐字|原文|一字不改/i.test(text)) return 'structured'
  if (/写(?:一篇|一段|一首|个故事|小说)|角色扮演|虚构|续写/.test(text)) return 'creative'
  if (/代码|报错|实现|插件|安装|排查|步骤|详细|方案|任务书|清单|表格|报告|计算|证明|教程|分析|怎么做/.test(text)) return 'task'
  if (/难过|失落|伤心|害怕|焦虑|累坏|委屈|难受/.test(text)) return 'support'
  return 'chat'
}
