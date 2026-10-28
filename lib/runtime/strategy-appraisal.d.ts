import type { AffectConfig } from '../config.js';
import type { IdentityBinding, RawMessage, ValidatedAppraisal } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
import { type EvtPayload } from './output-protocol.js';
/** QQ pre-evaluation is a cue only; the foreground tail remains the sole legacy settlement. */
export declare function observationStrategyAppraisals(payload: EvtPayload, message: RawMessage): ValidatedAppraisal[];
/** Read only this exact live source; a previous message's apology must never color this reply. */
export declare function currentStrategyAppraisal(repos: Repositories, binding: IdentityBinding, message: RawMessage, config: AffectConfig, transient?: readonly ValidatedAppraisal[], teasing?: boolean): ValidatedAppraisal | undefined;
