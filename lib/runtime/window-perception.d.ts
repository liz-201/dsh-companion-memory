import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding } from '../domain/types.js';
import type { ModelCaller, ModelChunk } from './turn-coordinator.js';
import { type WindowIdentity, type WindowObservation } from './window-probe.js';
import type { ComputerEvent } from './computer-events.js';
export interface Hypothesis {
    text: string;
    quote?: string;
    region?: number[];
    confidence: number;
    evidenceKind: 'text' | 'image-region';
}
export interface PerceptionObservation {
    principalId: string;
    conversationId: string;
    id: string;
    observedAtMs: number;
    expiresAtMs: number;
    scopeRevision: string;
    generation: number;
    window: WindowIdentity;
    facts: WindowObservation['facts'];
    hypotheses: Hypothesis[];
    previewImage?: string;
    ocrError?: string | null;
}
interface NativeProbe {
    list(signal?: AbortSignal): Promise<{
        windows: WindowIdentity[];
    }>;
    read(mode: 'uia' | 'image', window: WindowIdentity, signal?: AbortSignal): Promise<WindowObservation>;
}
export interface WindowPerceptionOptions {
    config: Config;
    repos: Repositories;
    callModel: ModelCaller;
    binding: () => IdentityBinding | null;
    onEvent: (event: ComputerEvent, binding: IdentityBinding) => void;
    native?: NativeProbe;
    now?: () => number;
    onUsage?: (id: string, usage: ModelChunk['usage']) => void;
}
/** Bounded, selected-window perception. Raw images are never persisted by this service. */
export declare class WindowPerception {
    private readonly options;
    private generation;
    private revision;
    private selected;
    private controller;
    private timer;
    private error;
    private target;
    private recent;
    private stable;
    private fingerprints;
    private readonly native;
    private readonly now;
    constructor(options: WindowPerceptionOptions);
    configure(): void;
    stop(): void;
    setTarget(binding: IdentityBinding): void;
    status(): {
        enabled: boolean;
        mode: "manual" | "bounded-auto";
        busy: boolean;
        generation: number;
        scopeRevision: string;
        selectedWindows: WindowIdentity[];
        error: string | null;
        recent: {
            principalId: string;
            conversationId: string;
            id: string;
            observedAtMs: number;
            expiresAtMs: number;
            scopeRevision: string;
            generation: number;
            window: WindowIdentity;
            facts: WindowObservation["facts"];
            hypotheses: Hypothesis[];
            ocrError?: string | null;
        }[];
        hostImageStorageRequired: boolean;
    };
    windows(): Promise<WindowIdentity[]>;
    prepareContext(query: string, binding: IdentityBinding): Promise<void>;
    revalidate(): Promise<void>;
    private allowed;
    select(windowId: number): Promise<WindowIdentity>;
    private check;
    inspect(windowId: number, mode: 'uia' | 'image', analyze?: boolean, publish?: boolean): Promise<PerceptionObservation>;
    scan(): Promise<void>;
}
export {};
