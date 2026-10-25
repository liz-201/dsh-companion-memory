import type { Config } from '../config.js';
import type { BackgroundQueue } from './background-queue.js';
/** Enqueue at startup, then once per UTC date even when the app restarts daily. */
export declare function scheduleDailyBackup(config: Config, background: BackgroundQueue, nowMs: number): boolean;
