import type { RawMessage } from '../domain/types.js'

/** Only trusted human channels may teach owner preferences or affect. Unknown sources fail closed. */
export function isHumanMessage(message: RawMessage): boolean {
  return message.role === 'user' && ['dsh', 'desktop', 'qq'].includes(message.sourceKind) && message.deletedAtMs === null
}

/**
 * 桥接回信的投递格式；与 `scripts/codex-mailbox-store.mjs` 注入的文本一致。
 * 这类文本走同一个 `user/message` 事件进来，若不标记就会被当成主人亲口说的话。
 */
const BRIDGE_PREFIX = /^\[Codex 协作回复 \/ mailbox [^\]]*\]/

/**
 * 入口标记：把机器投递的文本从人类来源里摘出去。
 * `isHumanMessage` 的白名单只认 dsh/desktop/qq，所以这里标成 `codex-bridge`
 * 后，习惯学习、事实提取、整理批次都会自动跳过它。
 */
export function detectSourceKind(text: string, fallback: string): string {
  return BRIDGE_PREFIX.test(text.trimStart()) ? 'codex-bridge' : fallback
}
