import type { EvtPayload } from './output-protocol.js';
/** Tagged reasoning is never visible history. An unclosed tag consumes the tail. */
export declare function visibleText(text: string): string;
/** Conservative fallback: no facts, no tasks, and no inference from quoted/technical text. */
export declare function localObservation(text: string): EvtPayload;
