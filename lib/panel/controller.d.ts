import type { Config } from '../config.js';
import type { Database } from '../storage/database.js';
import type { Repositories } from '../storage/repositories.js';
import type { OwnerIdentity } from '../domain/owner-identity.js';
import type { IdentityBinding } from '../domain/types.js';
import { type FishCommandDeps } from '../commands/handlers.js';
import type { ComputerEvents } from '../runtime/computer-events.js';
import type { WindowPerception } from '../runtime/window-perception.js';
export interface PanelControls {
    snapshot(input: {
        conversationId?: string;
        query?: string;
    }): unknown;
    action(input: unknown): unknown | Promise<unknown>;
}
interface PanelOptions {
    probeExtraction?: () => Promise<unknown>;
    perception?: WindowPerception;
    config: Config;
    db: Database;
    repos: Repositories;
    owner: OwnerIdentity;
    commands: FishCommandDeps;
    computer: ComputerEvents;
    activeTargets: () => IdentityBinding[];
    status: () => unknown;
    settingsChanged: () => void;
    scan: () => Promise<unknown>;
    preview: (binding: IdentityBinding) => Promise<unknown>;
    background: {
        start(): void;
        stop(): void;
        stats(): unknown;
    };
    review: {
        begin(binding: IdentityBinding, fixture: string, nowMs: number): string;
        end(binding: IdentityBinding): string;
    };
}
export declare class PluginPanel implements PanelControls {
    private readonly options;
    constructor(options: PanelOptions);
    private conversations;
    private binding;
    snapshot(input?: {
        conversationId?: string;
        query?: string;
    }): {
        continuous: import("../storage/continuous-affect.js").ContinuousAffectState | null;
        emotion: import("../config.js").EmotionConfig;
        perception: {
            settings: import("../config.js").PerceptionConfig;
            status: {
                enabled: boolean;
                mode: "manual" | "bounded-auto";
                busy: boolean;
                generation: number;
                scopeRevision: string;
                selectedWindows: import("../runtime/window-probe.js").WindowIdentity[];
                error: string | null;
                recent: {
                    principalId: string;
                    conversationId: string;
                    id: string;
                    observedAtMs: number;
                    expiresAtMs: number;
                    scopeRevision: string;
                    generation: number;
                    window: import("../runtime/window-probe.js").WindowIdentity;
                    facts: import("../runtime/window-probe.js").WindowObservation["facts"];
                    hypotheses: import("../runtime/window-perception.js").Hypothesis[];
                    ocrError?: string | null;
                }[];
                hostImageStorageRequired: boolean;
            } | null;
        };
        runtime: unknown;
        conversations: {
            id: string;
            personaId: string;
            label: string;
            available: boolean;
        }[];
        selected: string;
        state: import("../domain/types.js").AffectSnapshot;
        profile: import("../domain/personality-profile.js").PersonalityProfile | undefined;
        frequency: {
            dailyLimit: number;
            minGapMinutes: number;
            affection: number;
            liveliness: number;
            boost: number;
            reason: string;
        };
        gates: import("../proactive/candidate-builder.js").GateResult;
        proactive: {
            modelInterests: string[];
            enabled: boolean;
            adaptiveFrequency: boolean;
            adaptiveMaxDailyLimit: number;
            adaptiveMinGapMinutes: number;
            opportunityThreshold: number;
            shareSources: string[];
            timezone: string;
            quietStart: string;
            quietEnd: string;
            checkMinutes: number;
            spontaneousLimitPerDay: number;
            spontaneousMinGapMinutes: number;
            pauseAfterUnanswered: number;
            maxGenerationCallsPerCandidate: number;
        };
        computer: {
            settings: import("../config.js").ComputerEventsConfig;
            status: import("../runtime/computer-events.js").ComputerEventsStatus;
            recent: import("../runtime/computer-events.js").ComputerEvent[];
        };
        memories: import("../storage/repositories.js").MemoryRow[];
        habits: import("../storage/database.js").Row[];
        tasks: import("../storage/database.js").Row[];
        opportunities: import("../storage/database.js").Row[];
        events: import("../storage/database.js").Row[];
        emotionAppraisals: import("../storage/database.js").Row[];
        modelUsage: import("../storage/database.js").Row[];
        extractionJobs: import("../storage/database.js").Row[];
        feedback: import("../storage/database.js").Row[];
        expression: import("../storage/database.js").Row[];
        backups: import("../storage/backup.js").BackupSummary;
        background: unknown;
    };
    action(input: unknown): Promise<unknown>;
}
export {};
