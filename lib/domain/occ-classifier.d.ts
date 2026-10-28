import type { EmotionAppraisal } from './emotion-appraisal.js';
export declare const OCC_CATEGORIES: readonly ["admiration", "anger", "disappointment", "distress", "fear", "fears-confirmed", "gloating", "gratification", "gratitude", "happy-for", "hate", "hope", "joy", "love", "pity", "pride", "relief", "remorse", "reproach", "resentment", "satisfaction", "shame"];
export type OccCategory = typeof OCC_CATEGORIES[number];
export interface EmotionComponent {
    category: OccCategory;
    intensity: number;
}
export interface ClassifiedEmotion {
    components: EmotionComponent[];
    displays: string[];
    reasons: string[];
}
/** Classification uses validated situational evidence, never emotional keywords. */
export declare function classifyOcc(a: EmotionAppraisal, prior?: EmotionAppraisal): ClassifiedEmotion;
