import type { Repositories } from '../storage/repositories.js';
/** Preserve derived IDs across explicitly recorded same-owner identity migrations. */
export declare function reuseOwnerMemoryId(repos: Repositories, principalId: string, derive: (principal: string) => string): string;
