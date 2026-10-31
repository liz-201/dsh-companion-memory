/** Evidence-bound computational appraisal. Unknown is absent, never an invented zero. */
export interface EmotionAppraisal {
    /** The feeling's object, not the source speaker. Never infer relationship feelings from a task. */
    concern?: 'relationship' | 'self' | 'owner' | 'other' | 'topic';
    /** An exact source substring used to keep object-specific feelings on topic. */
    topic?: string;
    situation?: Partial<Record<SituationAxis, number>>;
    /** Explicitly unknown axes; a new observer must explain omissions instead of inventing values. */
    unresolved?: string[];
    focus: 'event' | 'action' | 'object';
    affectedParty?: 'self' | 'owner' | 'other';
    agency?: 'self' | 'owner' | 'other' | 'unknown';
    desirability?: number;
    desirabilityForOther?: number;
    likingForOther?: number;
    deservingness?: number;
    praiseworthiness?: number;
    appealingness?: number;
    /** Explicit owner-directed approach/withdrawal; object liking is not a substitute. */
    pull?: number;
    likelihood?: number;
    controllability?: number;
    unexpectedness?: number;
    relevance?: number;
    prospect?: 'pending' | 'confirmed' | 'disconfirmed' | 'none';
    suppliedEvidenceRef?: string;
    suppliedBehaviorRef?: string;
    unfairness?: number;
    relationshipThreat?: number;
    personalAttention?: number;
    helplessness?: number;
    quote: string;
    confidence: number;
}
export declare const SITUATION_AXES: readonly ["novelty", "knowledgeGap", "goalBlockage", "loss", "permanence", "separation", "attachment", "exposure", "incongruity", "aestheticImpact", "recollection", "safety", "monotony", "aversion", "comparison"];
export type SituationAxis = typeof SITUATION_AXES[number];
export declare function parseAppraisals(value: unknown): EmotionAppraisal[];
