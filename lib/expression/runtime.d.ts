import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { AffectSnapshot, IdentityBinding } from '../domain/types.js';
import type { ModelCaller } from '../runtime/turn-coordinator.js';
import { type ExpressionPlan } from '../domain/expression-plan.js';
import { type GuardResult } from './repair.js';
export declare class ExpressionRuntime {
    private readonly repos;
    private readonly config;
    private readonly callModel?;
    private plans;
    private exposure;
    constructor(repos: Repositories, config: Config, callModel?: ModelCaller | undefined);
    plan(state: AffectSnapshot, userText: string, nowMs: number): ExpressionPlan;
    private contactExposure;
    guard(text: string, state: AffectSnapshot, userText: string, nowMs: number, signal?: AbortSignal, sourceIds?: string[], binding?: IdentityBinding): Promise<GuardResult>;
}
