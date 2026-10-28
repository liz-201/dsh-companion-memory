/** Evidence-bound computational appraisal. Unknown is absent, never an invented zero. */
export interface EmotionAppraisal {
    focus: 'event' | 'action' | 'object';
    affectedParty?: 'self' | 'owner' | 'other';
    agency?: 'self' | 'owner' | 'other' | 'unknown';
    desirability?: number;
    desirabilityForOther?: number;
    likingForOther?: number;
    deservingness?: number;
    praiseworthiness?: number;
    appealingness?: number;
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
export declare function parseAppraisals(value: unknown): EmotionAppraisal[];
