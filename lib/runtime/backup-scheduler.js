/** Enqueue at startup, then once per UTC date even when the app restarts daily. */
export function scheduleDailyBackup(config, background, nowMs) {
    if (!config.storage.backupDaily)
        return false;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    // Back up before replaying a recovered extraction backlog.
    return background.enqueue('backup', {}, { dedupKey: `backup:${config.companion.id}:${day}`, availableAtMs: 0, nowMs });
}
//# sourceMappingURL=backup-scheduler.js.map