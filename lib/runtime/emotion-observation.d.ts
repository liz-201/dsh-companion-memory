import { type EvtPayload } from './output-protocol.js';
import { type EmotionAppraisal } from '../domain/emotion-appraisal.js';
export declare const EMOTION_CONTRACT: string;
/** The base contract is unchanged; the erotic appendix is opt-in per request. */
export declare function buildEmotionContract(includeEroticCue?: boolean): string;
export declare function parseObservation(output: string): {
    legacy: EvtPayload;
    appraisals?: EmotionAppraisal[];
};
