import type { Repositories } from './repositories.js';
import type { Personality } from '../domain/types.js';
import { type PersonalityOptions, type PersonalityProfile } from '../domain/personality-profile.js';
export declare class PersonalityProfiles {
    private readonly repos;
    constructor(repos: Repositories);
    get(companionId: string, personaId: string): PersonalityProfile | undefined;
    ensure(companionId: string, personaId: string, legacy: Personality, options: PersonalityOptions, nowMs: number): PersonalityProfile;
    configure(companionId: string, personaId: string, legacy: Personality, options: PersonalityOptions, nowMs: number, source?: PersonalityProfile['source']): PersonalityProfile;
}
