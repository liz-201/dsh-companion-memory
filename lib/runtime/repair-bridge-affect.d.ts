import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
/** Repair only deterministic technical-prefix misclassification; retain source and audit history. */
export declare function repairBridgeAffect(repos: Repositories, config: Config, nowMs: number): {
    events: number;
    owners: number;
    backup: string | null;
};
