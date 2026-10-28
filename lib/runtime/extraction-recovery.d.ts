import type { Repositories } from '../storage/repositories.js';
/** Receipt per job: an older cloud snapshot can arrive after the startup recovery pass. */
export declare function recoverCapabilityExtractions(repos: Repositories, nowMs?: number): number;
