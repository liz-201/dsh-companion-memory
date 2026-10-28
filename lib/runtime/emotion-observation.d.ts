import { type EvtPayload } from './output-protocol.js';
import { type EmotionAppraisal } from '../domain/emotion-appraisal.js';
export declare const EMOTION_CONTRACT: string;
export declare function parseObservation(output: string): {
    legacy: EvtPayload;
    appraisals?: EmotionAppraisal[];
};
