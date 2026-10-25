import type { ConsolidationBatch, ConsolidationPlan } from './consolidator.js';
/** Read complete JSON values, respecting quoted braces and escaped quotes. */
export declare function parseConsolidationOutput(output: string): Record<string, unknown> | null;
export declare function requestConsolidationPlan(batch: ConsolidationBatch, afterSeq: number, generate: (correction: string) => Promise<string>): Promise<{
    plan: ConsolidationPlan;
    attempts: number;
    degraded: boolean;
    problems: string[];
}>;
