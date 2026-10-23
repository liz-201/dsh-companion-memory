/** Optional port for dsh-onebot-qq 0.9.3. No connection, global hook, or cached service. */
export function createCompanionPort({ getService, sendToChat, botAccountId, sessionId, log = () => {} }) {
  return async (inbound, commandOnly = false) => {
    const command = /^\/fish(?:\s|$)/iu.test(inbound.text.trim())
    if (commandOnly !== command || inbound.kind !== 'private') return false
    if (!command && (inbound.media.length > 0 || inbound.replyId !== undefined || inbound.forwardId !== undefined)) return false
    let service
    try { service = getService?.() } catch { return false }
    if (!service?.accepts?.(inbound.chatId)) return false
    const bot = String(botAccountId())
    if (!/^\d+$/.test(bot)) return false
    const send = async text => {
      try {
        const ids = await sendToChat(inbound.chatId, text)
        return Array.isArray(ids) && ids.length > 0
          ? { kind: 'accepted', platformMessageId: String(ids.at(-1)), atMs: Date.now() }
          : { kind: 'unknown', code: 'empty-bridge-receipt', atMs: Date.now() }
      } catch (error) {
        log('warn', 'companion delivery unconfirmed: ' + String(error?.name ?? 'error'))
        return { kind: 'unknown', code: 'bridge-send-failed', atMs: Date.now() }
      }
    }
    // Commands use the same verified bot binding as the next normal inbound turn.
    const input = { chatId: inbound.chatId, botAccountId: bot, userId: inbound.userId,
      text: inbound.text, platformMessageKey: inbound.messageId ?? null, sessionId: sessionId(inbound.chatId) ?? null, send }
    try {
      const result = await service.handleInbound(input)
      if (!result.handled) return false
      if (result.outcome?.status === 'failed' && !result.outcome.say) await send('陪伴回复未完成，原始消息已保留。请稍后重试或使用 /fish doctor。')
      // Do not start a second Agent turn, including when the first delivery result is unknown.
      return true
    } catch (error) {
      log('warn', 'companion turn failed: ' + String(error?.name ?? 'error'))
      await send('陪伴处理未完成，请使用 /fish doctor 查看状态。')
      return true
    }
  }
}
