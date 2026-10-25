import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
/** Affection and an outgoing current persona may use the explicitly configured extra budget. */
export declare function proactiveFrequency(config: Config, repos: Repositories, principalId: string): {
    dailyLimit: number;
    minGapMinutes: number;
    affection: number;
    liveliness: number;
    boost: number;
    reason: string;
};
