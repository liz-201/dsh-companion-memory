import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding } from './types.js';
import type { PersonaContext } from '../runtime/persona-context.js';
export declare class OwnerIdentity {
    private readonly repos;
    private readonly config;
    get ownerId(): string;
    readonly deviceId: string;
    get principalId(): string;
    private readonly initialOwnerId;
    constructor(repos: Repositories, config: Config, nowMs?: number, deviceId?: string);
    binding(channel: string, address: string, accountId?: string, nowMs?: number, persona?: PersonaContext): IdentityBinding;
    /** Fold only explicitly allowed private QQ identities into the same local owner. */
    adoptLegacyQq(nowMs?: number): number;
}
