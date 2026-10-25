import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryTransfer } from './memory-transfer.js';
/** Loopback UI with an unguessable same-origin action token; no CORS/credential echo. */
export declare function createTransferHandler(transfer: MemoryTransfer): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
