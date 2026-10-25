/**
 * 删除与 tombstone（任务书 §10.6 / §15.3 / §21.2）。
 *
 * 用户说「忘掉这件事」时，要清掉的是一整条派生链：
 *   原文 → 派生记忆 → FTS → embedding → 检查点引用 → 未结任务 → 情感影响
 *
 * 情感影响不能直接改数值（那会让历史与状态不一致），而是把相关 affect event
 * 标为 retracted，再由投影重算。这里记录 tombstone，恢复旧备份后重放它。
 */

import type { Database } from './database.js'
import type { Repositories } from './repositories.js'
import { revokeDerivedSources } from '../memory/habit-learning.js'
import type { Config } from '../config.js'
import { rebuildAffect } from '../domain/affect-projector.js'
import { memoryFingerprint, suppressedBy, type MemorySuppression } from '../memory/suppression.js'

export type DeleteSelector =
  | { kind: 'memory'; memoryId: string }
  | { kind: 'message'; messageId: string }
  | { kind: 'episode'; episodeId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'all' }

export interface DeleteResult {
  tombstoneId: string
  removedMemories: string[]
  removedMessages: string[]
  retractedAffectEvents: number
  clearedCheckpoints: number
  cancelledTasks: number
  /** 说明哪些副本不在本次删除范围内（备份窗口）。 */
  notes: string[]
}

export function deleteScope(
  db: Database,
  repos: Repositories,
  principalId: string,
  selector: DeleteSelector,
  nowMs: number,
  backupKeepDays: number,
  config?: Config,
): DeleteResult {
  if (selector.kind === 'message' && db.get<{ principal_id: string }>('SELECT c.principal_id FROM raw_messages r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = ?', selector.messageId)?.principal_id !== principalId) throw new Error('消息不属于当前角色')
  if ((selector.kind === 'message' || selector.kind === 'all') && !config) throw new Error('删除原话需要提供当前配置以重建情感投影')
  const removedMemories: string[] = []
  const removedMessages: string[] = []
  const suppressed: MemorySuppression[] = []
  let retracted = 0
  let clearedCheckpoints = 0
  let cancelledTasks = 0
  const tombstoneId = `tb_${nowMs}_${Math.random().toString(36).slice(2, 8)}`

  db.transaction(() => {
    const memoryIds = new Set<string>()

    if (selector.kind === 'memory') {
      memoryIds.add(selector.memoryId)
    } else if (selector.kind === 'message') {
      for (const memoryId of memoriesForMessage(db, selector.messageId)) memoryIds.add(memoryId)
      removedMessages.push(selector.messageId)
    } else if (selector.kind === 'episode') {
      for (const memoryId of memoriesForEpisode(db, selector.episodeId)) memoryIds.add(memoryId)
    } else if (selector.kind === 'task') {
      db.run("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status IN ('proposed','confirmed')", selector.taskId)
      cancelledTasks += 1
    } else {
      for (const row of db.all<{ id: string }>('SELECT id FROM memories WHERE principal_id = ?', principalId)) {
        memoryIds.add(row.id)
      }
      for (const row of db.all<{ id: string }>('SELECT id FROM raw_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE principal_id = ?)', principalId)) {
        removedMessages.push(row.id)
      }
      clearedCheckpoints += clearCheckpoints(db, principalId)
      cancelledTasks += Number(
        db.run(
          "UPDATE tasks SET status = 'cancelled' WHERE principal_id = ? AND status IN ('proposed','confirmed')",
          principalId,
        ).changes,
      )
    }

    for (const memoryId of memoryIds) {
      const row = repos.getMemory(memoryId)
      if (row === undefined || row.principal_id !== principalId) continue
      suppressed.push({ id: memoryId, claimHash: memoryFingerprint(row.claim), objectHash: row.object_json === null ? null : memoryFingerprint(JSON.parse(row.object_json)), sourceIds: repos.memoryEvidence(memoryId).map(item => item.messageId) })
      db.run('DELETE FROM memory_evidence WHERE memory_id = ?', memoryId)
      db.run('DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?', memoryId, memoryId)
      db.run('DELETE FROM memories WHERE id = ?', memoryId)
      repos.removeFromIndex(memoryId)
      removedMemories.push(memoryId)
    }

    for (const messageId of removedMessages) {
      db.run('DELETE FROM memory_evidence WHERE message_id = ?', messageId)
      db.run("UPDATE raw_messages SET content = '', deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL", nowMs, messageId)
    }

    // 情感影响：把相关事件标 retracted，由后续重投影计算当前状态。
    if (removedMessages.length > 0) {
      const placeholders = removedMessages.map(() => '?').join(',')
      const result = db.run(
        `UPDATE affect_events SET status = 'retracted'
         WHERE principal_id = ?
           AND (appraisal_id IN (SELECT id FROM appraisals WHERE source_message_id IN (${placeholders}))
             OR json_extract(payload_json, '$.appraisal.sourceMessageId') IN (${placeholders}))
           AND status = 'active'`,
        principalId,
        ...removedMessages,
        ...removedMessages,
      )
      retracted += result.changes
      db.run(
        `UPDATE appraisals SET status = 'retracted' WHERE source_message_id IN (${placeholders})`,
        ...removedMessages,
      )
    }

    if (selector.kind === 'episode') {
      db.run("UPDATE relationship_episodes SET status = 'archived' WHERE id = ?", selector.episodeId)
    }

    revokeDerivedSources(repos, [...removedMemories, ...removedMessages])
    if (retracted > 0 && config) {
      const stored = repos.getSnapshot(principalId)
      repos.putSnapshot(rebuildAffect(repos, config, principalId, nowMs), stored?.revision ?? 0)
    }
    repos.insertTombstone({
      id: tombstoneId,
      principalId,
      selector: { ...selector, suppressed },
      affectedIds: [...removedMemories, ...removedMessages],
      createdAtMs: nowMs,
    })
    repos.audit({
      principalId,
      kind: 'delete',
      entityId: selector.kind === 'all' ? null : selectorId(selector),
      payload: {
        selector: selector.kind,
        memories: removedMemories.length,
        messages: removedMessages.length,
        affectEvents: retracted,
      },
      createdAtMs: nowMs,
    })
  })

  return {
    tombstoneId,
    removedMemories,
    removedMessages,
    retractedAffectEvents: retracted,
    clearedCheckpoints,
    cancelledTasks,
    notes: [
      `当前库与外键派生数据已清除；文档备份目录里 ${backupKeepDays} 天内（backupRetentionDays）的历史备份仍可能包含这些内容。`,
      '恢复旧备份后必须先重放 tombstone，否则已删除内容会重新出现。',
    ],
  }
}

/** 恢复备份后调用：把 tombstone 里记录过的行再次清掉。 */
export function replayTombstones(db: Database, repos: Repositories, nowMs: number, config?: Config): { replayed: number; removedMemories: number } {
  let replayed = 0
  let removedMemories = 0
  const rebuild = new Set<string>()
  for (const row of repos.listTombstones()) {
    const selectorJson = String(row['selector_json'] ?? '{}')
    let selector: DeleteSelector | undefined
    try {
      selector = JSON.parse(selectorJson) as DeleteSelector
    } catch {
      selector = undefined
    }
    if (selector === undefined) continue
    const affected = String(row['affected_ids_json'] ?? '[]')
    let ids: string[] = []
    try {
      ids = JSON.parse(affected) as string[]
    } catch {
      ids = []
    }
    db.transaction(() => {
      const principalId = String(row['principal_id'])
      for (const memory of db.all<{ id: string; claim: string; object_json: string | null }>('SELECT id, claim, object_json FROM memories WHERE principal_id = ?', principalId)) if (suppressedBy(selectorJson, { id: memory.id, claim: memory.claim, object: memory.object_json === null ? null : JSON.parse(memory.object_json), sourceIds: repos.memoryEvidence(memory.id).map(item => item.messageId) })) ids.push(memory.id)
      revokeDerivedSources(repos, ids)
      for (const id of ids) {
        if (repos.getMemory(id)?.principal_id === principalId) {
          repos.removeFromIndex(id)
          db.run('DELETE FROM memory_evidence WHERE memory_id = ?', id)
          db.run('DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?', id, id)
          const result = db.run('DELETE FROM memories WHERE id = ?', id)
          removedMemories += result.changes
        } else {
          db.run("UPDATE raw_messages SET content = '', deleted_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL AND conversation_id IN (SELECT id FROM conversations WHERE principal_id = ?)", nowMs, id, principalId)
          if (db.run("UPDATE affect_events SET status = 'retracted' WHERE principal_id = ? AND status = 'active' AND json_extract(payload_json, '$.appraisal.sourceMessageId') = ?", principalId, id).changes > 0) rebuild.add(principalId)
        }
      }
    })
    replayed += 1
  }
  for (const principalId of rebuild) {
    if (config) { const stored = repos.getSnapshot(principalId); repos.putSnapshot(rebuildAffect(repos, config, principalId, nowMs), stored?.revision ?? 0) }
    else repos.setSetting(`local.affect-rebuild:${principalId}`, '1', nowMs)
  }
  return { replayed, removedMemories }
}

function selectorId(selector: DeleteSelector): string {
  switch (selector.kind) {
    case 'memory':
      return selector.memoryId
    case 'message':
      return selector.messageId
    case 'episode':
      return selector.episodeId
    case 'task':
      return selector.taskId
    default:
      return '*'
  }
}

function memoriesForMessage(db: Database, messageId: string): string[] {
  return db
    .all<{ memory_id: string }>('SELECT memory_id FROM memory_evidence WHERE message_id = ?', messageId)
    .map((row) => row.memory_id)
}

function memoriesForEpisode(db: Database, episodeId: string): string[] {
  return db
    .all<{ id: string }>(
      `SELECT m.id FROM memories m
       JOIN memory_evidence e ON e.memory_id = m.id
       WHERE e.message_id IN (
         SELECT json_each.value FROM relationship_episodes, json_each(relationship_episodes.source_message_ids_json)
         WHERE relationship_episodes.id = ?
       )`,
      episodeId,
    )
    .map((row) => row.id)
}

function clearCheckpoints(db: Database, principalId: string): number {
  const result = db.run(
    `DELETE FROM topic_checkpoints WHERE conversation_id IN (SELECT id FROM conversations WHERE principal_id = ?)`,
    principalId,
  )
  return result.changes
}
