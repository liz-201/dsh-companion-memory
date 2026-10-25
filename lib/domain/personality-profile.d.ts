import type { Personality } from './types.js';
export declare const TRAITS: readonly ["irritability", "sensitivity", "directness", "selfControl", "warmth", "initiative", "socialEnergy", "playfulness", "reserve", "conscientiousness", "curiosity", "optimism"];
export type Trait = typeof TRAITS[number];
export type Traits = Record<Trait, number>;
export declare const NEUTRAL: Traits;
export declare const TEMPLATES: Record<string, Partial<Traits>>;
export interface PersonalityOptions {
    mix: Record<string, number>;
    overrides: Partial<Traits>;
    variation: {
        enabled: boolean;
        maxDelta: number;
        seed: string | null;
    };
}
export interface PersonalityProfile {
    schemaVersion: 2;
    companionId: string;
    personaId: string;
    revisionId: string;
    parentRevisionIds: string[];
    traits: Traits;
    templates: {
        id: string;
        weight: number;
    }[];
    explicitOverrides: Partial<Traits>;
    seed: string | null;
    generatorVersion: string;
    source: 'legacy' | 'owner' | 'mapped' | 'import';
    createdAtMs: number;
}
export declare function validatePersonality(input: PersonalityOptions): void;
export declare function composePersonality(input: {
    companionId: string;
    personaId: string;
    options: PersonalityOptions;
    nowMs: number;
    legacy?: Personality;
    parents?: string[];
    source?: PersonalityProfile['source'];
}): PersonalityProfile;
