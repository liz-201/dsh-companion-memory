import type { Repositories } from '../storage/repositories.js';
export interface ComputerEvidence {
    id: string;
    principalId: string;
    conversationId: string;
    summary: string;
    expiresAtMs: number;
}
export declare function computerEvidence(repos: Repositories, id: string, principalId: string, conversationId: string, nowMs: number): ComputerEvidence | null;
