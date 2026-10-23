import type { IdentityBinding } from '../domain/types.js';
import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
export declare class ReviewSandbox {
    private readonly repos;
    private readonly config;
    constructor(repos: Repositories, config: Config);
    binding(real: IdentityBinding): IdentityBinding | null;
    begin(real: IdentityBinding, fixture: string, nowMs: number): string;
    end(real: IdentityBinding): string;
}
