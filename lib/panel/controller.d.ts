import type { Config } from '../config.js';
import type { Database } from '../storage/database.js';
import type { Repositories } from '../storage/repositories.js';
import type { OwnerIdentity } from '../domain/owner-identity.js';
import type { IdentityBinding } from '../domain/types.js';
import { type FishCommandDeps } from '../commands/handlers.js';
import type { ComputerEvents } from '../runtime/computer-events.js';
export interface PanelControls {
    snapshot(input: {
        conversationId?: string;
        query?: string;
    }): unknown;
    action(input: unknown): unknown | Promise<unknown>;
}
interface PanelOptions {
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
        feedback: import("../storage/database.js").Row[];
        expression: import("../storage/database.js").Row[];
        backups: import("../storage/backup.js").BackupSummary;
        background: unknown;
    };
    action(input: unknown): Promise<unknown>;
}
export {};
