import type { EmotionAppraisal } from './emotion-appraisal.js'

/** Conservative host gate for an explicit owner-to-companion motivation. */
export function qualifiedOwnerPull(vector: EmotionAppraisal, source: string, privateConversation: boolean): number | undefined {
  if (!privateConversation || vector.pull === undefined || vector.confidence < .65) return undefined
  const text = vector.quote
  if (/[“”「」『』`]|假如|假设|如果|台词|引用|扮演|虚构|小说|例如|比如/.test(source)) return undefined
  if (/代码|插件|任务书|接口|编译|测试|报错|API|导出|同步|实现|教程/i.test(text)) return undefined
  const approach = /我(?:现在|今天|真的|还|也|很|有点|愿意)*(?:想|希望|喜欢|愿意).{0,16}(?:和你|跟你|陪你|你陪|靠近你|你多陪)|我.{0,8}(?:舍不得你|想你了)/.test(text)
  const withdrawal = /(?:别|不要|不准|停止).{0,12}(?:找我|联系我|靠近我|打扰我)|我.{0,8}不想.{0,12}(?:和你|跟你|你陪|靠近你)|离我远一点/
  const withdraw = withdrawal.test(text)
  if (vector.pull < 0 && withdraw) return vector.pull
  // A model-selected positive substring cannot override an explicit source boundary.
  if (vector.pull > 0 && approach && !withdrawal.test(source) && !/别.{0,12}当真|不代表|只是说说|不是真的|现在不行|不愿意/.test(source)) return vector.pull
  return undefined
}
