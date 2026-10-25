import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding, RawMessage } from '../domain/types.js';
export interface ExpressionHabit {
    id: string;
    kind: string;
    value: string;
    sources: string[];
    status: string;
}
export declare function learnExplicitHabit(repos: Repositories, binding: IdentityBinding, message: RawMessage): void;
export declare function activeHabits(repos: Repositories, binding: Pick<IdentityBinding, 'principalId' | 'visibility' | 'conversationId'>, nowMs: number): ExpressionHabit[];
export declare function revokeDerivedSources(repos: Repositories, deletedIds: readonly string[]): void;
