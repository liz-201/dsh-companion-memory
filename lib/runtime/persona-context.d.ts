import type { Config, PresetId } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
export interface PersonaContext {
    id: string;
    preset: PresetId;
}
/** No text classifier: explicit host identity wins; only persona sections form the fallback. */
export declare class PersonaContexts {
    private readonly repos;
    private readonly config;
    constructor(repos: Repositories, config: Config);
    resolve(agentValue: unknown, sections?: unknown): PersonaContext;
}
