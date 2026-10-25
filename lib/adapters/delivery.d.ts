export type DeliveryTarget = {
    channel: 'desktop';
    sessionId: string;
    personaId: string;
} | {
    channel: 'qq';
    accountId: string;
    chatId: string;
    personaId: string;
};
export interface DeliveryAdapter {
    capabilities(): {
        send: boolean;
        idempotency: boolean;
        receiptLookup: boolean;
    };
    send(input: {
        target: DeliveryTarget;
        idempotencyKey: string;
        content: string;
        expectedInboundSeq: number | null;
    }): Promise<{
        status: 'sent' | 'rejected' | 'unknown';
        externalMessageId?: string;
        retryable?: boolean;
    }>;
}
