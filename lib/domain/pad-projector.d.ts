import type { OccCategory, EmotionComponent } from './occ-classifier.js';
export type Pad = {
    pleasure: number;
    arousal: number;
    dominance: number;
};
/** Engineering priors v1, NOT measured psychological coordinates. */
export declare const PAD_PRIORS: Record<OccCategory, readonly [number, number, number]>;
export interface TimedComponents {
    atMs: number;
    components: EmotionComponent[];
    control?: number;
}
/** Closed-form event convolution avoids read-frequency and integration-step drift. */
export declare function projectPad(events: readonly TimedComponents[], atMs: number, halfLifeMinutes?: number, moodHalfLifeMinutes?: number): {
    emotion: Pad;
    mood: Pad;
    controlKnown: boolean;
};
