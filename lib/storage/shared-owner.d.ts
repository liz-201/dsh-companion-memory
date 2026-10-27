import type { Config } from '../config.js';
import type { Repositories } from './repositories.js';
export declare function sharedOwnerPrincipal(config: Config, ownerId: string): string;
/** A data migration, not a new schema: retain source IDs and evidence, with one live owner projection. */
export declare function unifyOwnerState(repos: Repositories, config: Config, ownerId: string, nowMs: number, options?: {
    backup?: boolean;
    sourceOwnerIds?: readonly string[];
}): number;
