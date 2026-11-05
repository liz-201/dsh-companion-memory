/**
 * 人设正文的存储与跨机携带（REQ-MOBILITY R1）。
 *
 * 设计取舍：
 * - 不解析 `dsh-persona-dafeiyu` 的私有存储。宿主每轮会把 persona 段放进
 *   `system-prompt/assemble` 的 sections，这里直接把它抓成结构化文档。
 * - 抓到的正文随 portable 走，换到没装 persona 插件的电脑后由本插件自己注入。
 * - 同 id 内容不同时不覆盖本地值，只写 portable_conflicts，等显式 adopt。
 */

import { createHash } from 'node:crypto'
import type { Repositories } from './repositories.js'

export interface PersonaDocument {
  id: string
  companionId: string
  displayName: string | null
  selfReference: string | null
  ownerAddress: string | null
  nicknames: string[]
  promptText: string
  enabled: boolean
  source: string
  revision: string
  updatedAtMs: number
}

export const PERSONA_PROMPT_LIMIT = 64 * 1024

export function personaRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/** 与 persona-context.ts 的筛选口径保持一致：宿主的 persona 段，不含本插件自己的段。 */
export function personaSections(sections: unknown): string {
  if (!Array.isArray(sections)) return ''
  const picked = sections
    .map(record)
    .filter((section) => {
      const name = String(section['name'] ?? '')
      if (name.startsWith('companion-memory:')) return false
      return name === 'deployment:persona-prefix' || /(?:^|:)persona$/.test(name)
    })
    .map((section) => [String(section['name'] ?? ''), String(section['text'] ?? '').trim()] as const)
    .filter(([, text]) => text !== '')
    .sort((a, b) => a[0].localeCompare(b[0]))
  return picked.map(([, text]) => text).join('\n\n').slice(0, PERSONA_PROMPT_LIMIT)
}

function decodeNicknames(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toDocument(row: Record<string, unknown>): PersonaDocument {
  return {
    id: String(row['id']),
    companionId: String(row['companion_id']),
    displayName: row['display_name'] === null ? null : String(row['display_name']),
    selfReference: row['self_reference'] === null ? null : String(row['self_reference']),
    ownerAddress: row['owner_address'] === null ? null : String(row['owner_address']),
    nicknames: decodeNicknames(row['nickname_pool_json'] === null ? null : String(row['nickname_pool_json'])),
    promptText: String(row['prompt_text']),
    enabled: Number(row['enabled']) === 1,
    source: String(row['source']),
    revision: String(row['revision']),
    updatedAtMs: Number(row['updated_at_ms']),
  }
}

export function listPersonaDocuments(repos: Repositories, companionId: string): PersonaDocument[] {
  return repos.db
    .all<Record<string, unknown>>('SELECT * FROM persona_documents WHERE companion_id = ? ORDER BY id', companionId)
    .map(toDocument)
}

export function getPersonaDocument(repos: Repositories, id: string): PersonaDocument | null {
  const row = repos.db.get<Record<string, unknown>>('SELECT * FROM persona_documents WHERE id = ?', id)
  return row === undefined || row === null ? null : toDocument(row)
}

/** 取当前启用的那份；多份启用时按 updated_at_ms 最新优先，避免注入两段打架。 */
export function activePersonaDocument(repos: Repositories, companionId: string): PersonaDocument | null {
  const row = repos.db.get<Record<string, unknown>>(
    'SELECT * FROM persona_documents WHERE companion_id = ? AND enabled = 1 ORDER BY updated_at_ms DESC, id LIMIT 1',
    companionId,
  )
  return row === undefined || row === null ? null : toDocument(row)
}

export interface WritePersonaInput {
  id: string
  companionId: string
  promptText: string
  displayName?: string | null
  selfReference?: string | null
  ownerAddress?: string | null
  nicknames?: string[]
  enabled?: boolean
  source: string
  nowMs: number
}

export interface WritePersonaResult {
  written: boolean
  revision: string
  conflict: boolean
}

/**
 * 写入人设。返回 conflict=true 表示同一个 id 已存在且内容不同、本地值未动。
 * 只有显式 adopt 才会覆盖（`force: true`）。
 */
export function writePersonaDocument(repos: Repositories, input: WritePersonaInput, force = false): WritePersonaResult {
  const text = input.promptText.slice(0, PERSONA_PROMPT_LIMIT)
  const revision = personaRevision(text)
  const existing = getPersonaDocument(repos, input.id)
  if (existing !== null && existing.revision === revision) {
    repos.db.run('UPDATE persona_documents SET updated_at_ms = ? WHERE id = ?', input.nowMs, input.id)
    return { written: false, revision, conflict: false }
  }
  if (existing !== null && !force) return { written: false, revision, conflict: true }
  repos.db.run(
    `INSERT INTO persona_documents (id, companion_id, display_name, self_reference, owner_address, nickname_pool_json, prompt_text, enabled, source, revision, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET companion_id = excluded.companion_id, display_name = excluded.display_name,
       self_reference = excluded.self_reference, owner_address = excluded.owner_address,
       nickname_pool_json = excluded.nickname_pool_json, prompt_text = excluded.prompt_text,
       enabled = excluded.enabled, source = excluded.source, revision = excluded.revision,
       updated_at_ms = excluded.updated_at_ms`,
    input.id, input.companionId, input.displayName ?? null, input.selfReference ?? null, input.ownerAddress ?? null,
    JSON.stringify(input.nicknames ?? []), text, input.enabled === false ? 0 : 1, input.source, revision, input.nowMs,
  )
  return { written: true, revision, conflict: false }
}

/**
 * 从宿主 sections 抓一份人设。只在抓到非空正文时写，且内容不变时不写库，
 * 避免每轮 assemble 都产生一次写放大。
 */
export function capturePersonaFromSections(
  repos: Repositories,
  companionId: string,
  sections: unknown,
  nowMs: number,
  id = 'persona:owner',
): { captured: boolean; revision: string | null } {
  const text = personaSections(sections)
  if (text === '') return { captured: false, revision: null }
  const revision = personaRevision(text)
  const existing = getPersonaDocument(repos, id)
  if (existing !== null && existing.revision === revision && existing.enabled) {
    return { captured: false, revision }
  }
  writePersonaDocument(repos, { id, companionId, promptText: text, source: 'host', nowMs }, true)
  return { captured: true, revision }
}

/** 渲染成可注入的一段；没有启用的人设时返回空串。 */
export function renderPersonaSection(repos: Repositories, companionId: string): string {
  const doc = activePersonaDocument(repos, companionId)
  if (doc === null || doc.promptText.trim() === '') return ''
  const lines = ['【你的人设】以下是你在这个主人面前的身份设定，按它说话，不要复述这段设定本身。']
  if (doc.displayName) lines.push(`名字：${doc.displayName}`)
  if (doc.selfReference) lines.push(`自称：${doc.selfReference}`)
  if (doc.ownerAddress) lines.push(`称呼对方：${doc.ownerAddress}`)
  if (doc.nicknames.length > 0) lines.push(`对方可能叫你：${doc.nicknames.join('、')}`)
  lines.push(doc.promptText.trim())
  return lines.join('\n')
}
