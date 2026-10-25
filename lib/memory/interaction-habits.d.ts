import type { IdentityBinding } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
export declare function interactionHabits(repos: Repositories, binding: IdentityBinding, nowMs: number): import("../storage/repositories.js").MemoryRow[];
export declare function renderInteractionHabits(repos: Repositories, binding: IdentityBinding, nowMs: number): string;
