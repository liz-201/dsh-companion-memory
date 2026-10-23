import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { Row } from '../storage/database.js';
import type { AffectSnapshot, RelationshipDelta } from './types.js';
export declare function dailyUsage(rows: readonly Row[], nowMs: number, config: Config): RelationshipDelta;
/** Replay remaining source events, preserving the current personality and explicit reset baseline. */
export declare function rebuildAffect(repos: Repositories, config: Config, principalId: string, nowMs: number): AffectSnapshot;
