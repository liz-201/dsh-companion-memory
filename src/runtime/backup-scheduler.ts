import type { Config } from '../config.js'
import type { BackgroundQueue } from './background-queue.js'

/** Enqueue at startup, then once per UTC date even when the app restarts daily. */
export function scheduleDailyBackup(config: Config, background: BackgroundQueue, nowMs: number): boolean {
  if (!config.storage.backupDaily) return false
  const day = new Date(nowMs).toISOString().slice(0, 10)
  // Back up before replaying a recovered extraction backlog.
  return background.enqueue('backup', {}, { dedupKey: `backup:${config.companion.id}:${day}`, availableAtMs: 0, nowMs })
}
