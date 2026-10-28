import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function probeWindow(mode, window, signal) {
    if (process.platform !== 'win32')
        return Promise.reject(Error('Windows perception is unavailable on this platform'));
    if (window && (!Number.isSafeInteger(window.windowId) || window.windowId <= 0 || !Number.isSafeInteger(window.processId) || window.processId <= 0 || typeof window.app !== 'string' || window.app.length > 80 || !/^\d{1,22}$/.test(window.startedAt)))
        return Promise.reject(Error('Invalid window identity'));
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../../scripts/windows-perception.ps1', import.meta.url)), '-Mode', mode];
    if (window)
        args.push('-WindowId', String(window.windowId), '-ExpectedProcessId', String(window.processId), '-ExpectedProcessName', window.app, '-ExpectedStartedAt', window.startedAt);
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', args, { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', ...(signal ? { signal } : {}) }, (error, stdout) => {
            if (error) {
                reject(Error(signal?.aborted ? 'perception-cancelled' : 'window-probe-unavailable'));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                if (result.error)
                    throw Error(result.error);
                resolve(result);
            }
            catch {
                reject(Error('Invalid window probe result'));
            }
        });
    });
}
//# sourceMappingURL=window-probe.js.map