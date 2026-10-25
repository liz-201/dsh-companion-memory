import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding } from '../domain/types.js';
import type { ComputerEvent } from '../runtime/computer-events.js';
/** Local device observations stay outside transferable memory and never masquerade as user messages. */
export declare function observeComputerEvent(repos: Repositories, config: Config, event: ComputerEvent, bindings: readonly IdentityBinding[]): void;
export declare function clearComputerEvidence(repos: Repositories): void;
