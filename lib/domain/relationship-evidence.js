/** Conservative host gate for an explicit owner-to-companion motivation. */
export function qualifiedOwnerPull(vector, source, privateConversation) {
    if (!privateConversation || vector.pull === undefined || vector.confidence < .65)
        return undefined;
    const text = vector.quote;
    if (/[“”「」『』`]|假如|假设|如果|台词|引用|扮演|虚构|小说|例如|比如/.test(source))
        return undefined;
    if (/(?:他|她|他们|她们|朋友|同事)(?:说|表示|觉得|希望|想)|转述/.test(source))
        return undefined;
    if (/代码|插件|任务书|接口|编译|测试|报错|API|导出|同步|实现|教程/i.test(source))
        return undefined;
    // Work context blocks only when it frames companionship as a schedule item, so
    // "工作到很晚，想和你聊会" still counts while "工作安排：多陪我一会" does not.
    if (/(?:工作|开会|排期|会议|项目|加班)(?:的)?(?:安排|时间|日程|计划)|(?:安排|时间|日程|计划)(?:里|中)?(?:的)?(?:工作|开会|排期|会议)/.test(source))
        return undefined;
    const adverb = '(?:现在|今天|最近|真的|还|也|很|挺|超|好|太|特别|有点|愿意)';
    const approach = new RegExp(`我${adverb}*(?:想|希望|喜欢|愿意).{0,16}(?:和你|跟你|陪你|你陪|靠近你|你多陪)|我.{0,8}(?:舍不得你|想你了)`).test(text)
        || new RegExp(`(?:^|[，。！？!?\\s])(?:我)?${adverb}*(?:喜欢(?:和你|跟你)(?:聊天|聊聊)?|想(?:和|跟)你(?:聊|说)|想你(?!帮|做|看|问|告诉|说|们)|(?:你)?多陪我(?:一会|会儿|一下))`).test(text);
    const withdrawal = /(?:别|不要|不准|停止).{0,12}(?:找我|联系我|靠近我|打扰我)|我.{0,8}不想.{0,12}(?:和你|跟你|你陪|靠近你)|离我远一点/;
    const withdraw = withdrawal.test(text);
    if (vector.pull < 0 && withdraw)
        return vector.pull;
    // A model-selected positive substring cannot override an explicit source boundary.
    if (vector.pull > 0 && approach && !withdrawal.test(source) && !/别.{0,12}当真|不代表|只是说说|不是真的|现在不行|不愿意|不想你|不喜欢(?:和你|跟你)|不(?:用|要|必).{0,4}陪我/.test(source))
        return vector.pull;
    return undefined;
}
//# sourceMappingURL=relationship-evidence.js.map