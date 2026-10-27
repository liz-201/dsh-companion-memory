import type { Repositories } from '../storage/repositories.js'

/** Preserve derived IDs across explicitly recorded same-owner identity migrations. */
export function reuseOwnerMemoryId(repos: Repositories, principalId: string, derive: (principal: string) => string): string {
  const canonical = derive(principalId)
  const prefix = 'identity.shared-alias:'
  const reverse = new Map<string, string[]>()
  for (const row of repos.db.all<{ key: string; value: string }>("SELECT key,value FROM plugin_settings WHERE key LIKE 'identity.shared-alias:%' ORDER BY key LIMIT 4096")) {
    const source = row.key.slice(prefix.length)
    if (!source || !row.value) continue
    const sources = reverse.get(row.value) ?? []
    sources.push(source)
    reverse.set(row.value, sources)
  }
  const principals = [principalId], visited = new Set(principals)
  for (let index = 0; index < principals.length && principals.length < 256; index++) {
    for (const source of reverse.get(principals[index]!) ?? []) {
      if (visited.has(source)) continue
      visited.add(source)
      principals.push(source)
      if (principals.length >= 256) break
    }
  }
  const variants = [...new Set(principals.slice(1).map(derive))].filter(id => id !== canonical)
  const variantSet = new Set(variants)
  // An older deletion may contain only its exact ID, without a semantic hash.
  // Reuse it before any live row so the normal suppression check still rejects it.
  for (const tombstone of repos.listTombstones(principalId)) {
    const selector = JSON.parse(String(tombstone['selector_json'])) as { memoryId?: unknown }
    if (typeof selector.memoryId === 'string' && variantSet.has(selector.memoryId)) return selector.memoryId
  }
  const current = repos.getMemory(canonical)
  if (current?.principal_id === principalId) return canonical
  for (const id of variants) if (repos.getMemory(id)?.principal_id === principalId) return id
  // A hash collision must not let FactUpdater append evidence to another owner.
  if (current) throw new Error('记忆标识属于其他主人，已停止写入。')
  return canonical
}
