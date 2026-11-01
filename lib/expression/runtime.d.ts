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
    private intimacyPlans;
    private intimacyDeliveries;
    constructor(repos: Repositories, config: Config, callModel?: ModelCaller | undefined);
    plan(state: AffectSnapshot, userText: string, nowMs: number, binding?: IdentityBinding): ExpressionPlan;
    /** Called only by actual delivery ingress, never by preview or plan reads. */
    recordDelivery(binding: IdentityBinding, text: string, nowMs: number): void;
    private contactExposure;
    guard(text: string, state: AffectSnapshot, userText: string, nowMs: number, signal?: AbortSignal, sourceIds?: string[], binding?: IdentityBinding): Promise<GuardResult>;
}
