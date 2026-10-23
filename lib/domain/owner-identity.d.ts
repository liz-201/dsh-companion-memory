import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding } from './types.js';
export declare class OwnerIdentity {
    private readonly repos;
    private readonly config;
    readonly ownerId: string;
    readonly deviceId: string;
    readonly principalId: string;
    constructor(repos: Repositories, config: Config, nowMs?: number);
    binding(channel: string, address: string, accountId?: string, nowMs?: number): IdentityBinding;
    /** Fold only explicitly allowed private QQ identities into the same local owner. */
    adoptLegacyQq(nowMs?: number): number;
}
