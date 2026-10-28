import type { RawMessage } from '../domain/types.js'

const BRIDGE_PREFIX = /^\[Codex 协作回复 \/ mailbox [^\]]*\]/u

/** Keep older mislabelled bridge rows from becoming owner evidence on later reads. */
export function detectSourceKind(text: string, fallback: string): string {
  return BRIDGE_PREFIX.test(text.trimStart()) ? 'codex-bridge' : fallback
}

export function isHumanMessage(message: Pick<RawMessage, 'role' | 'sourceKind' | 'content' | 'deletedAtMs'>): boolean {
  return message.role === 'user' && message.deletedAtMs === null
    && ['dsh', 'desktop', 'qq'].includes(detectSourceKind(message.content, message.sourceKind))
}

/** SQL equivalent for bounded source selection; aliases are code-owned identifiers. */
export function humanSourceSql(alias = ''): string {
  if (alias && !/^[a-z_][a-z0-9_]*$/iu.test(alias)) throw Error('Invalid source alias')
  const p = alias ? `${alias}.` : ''
  const text = `ltrim(${p}content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))`
  const prefix = '[Codex 协作回复 / mailbox '
  return `${p}role = 'user' AND ${p}deleted_at_ms IS NULL AND ${p}source_kind IN ('dsh','desktop','qq') AND NOT (substr(${text},1,${prefix.length}) = '${prefix}' AND instr(substr(${text},${prefix.length + 1}),']') > 0)`
}
