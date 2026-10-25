import type { IdentityBinding, DeliveryReceipt } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
export declare class DesktopDelivery {
    private readonly repos;
    private targets;
    private busy;
    constructor(repos: Repositories);
    register(sessionValue: unknown, binding: IdentityBinding, personaId: string): void;
    remove(sessionId: string): void;
    setBusy(sessionId: string, value: boolean): void;
    isBusy(conversationId: string): boolean;
    list(): {
        conversationId: string;
        principalId: string;
    }[];
    has(conversationId: string): boolean;
    binding(conversationId: string): IdentityBinding | null;
    personaText(conversationId: string): string | null;
    send(conversationId: string, text: string, key: string, expectedInboundSeq: number | null): Promise<DeliveryReceipt>;
}
