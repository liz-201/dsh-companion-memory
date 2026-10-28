import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryTransfer } from './memory-transfer.js';
import type { PanelControls } from '../panel/controller.js';
export interface TransferCloseoutStatus {
    paused: boolean;
    drained: boolean;
    activeLeases: number;
    foreground: number;
    pending: number;
}
export interface TransferLifecycle {
    pause(): TransferCloseoutStatus | Promise<TransferCloseoutStatus>;
    status(): TransferCloseoutStatus | Promise<TransferCloseoutStatus>;
    resume(): TransferCloseoutStatus | Promise<TransferCloseoutStatus>;
}
/** Loopback UI with an unguessable same-origin action token; no CORS/credential echo. */
export declare function createTransferHandler(transfer: MemoryTransfer, controls?: PanelControls, lifecycle?: TransferLifecycle): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
