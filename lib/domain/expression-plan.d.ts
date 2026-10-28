import type { AffectSnapshot } from './types.js';
import { type PersonalityProfile } from './personality-profile.js';
import { type TaskMode } from '../expression/task-mode.js';
import type { ContinuousAffectState } from './continuous-affect.js';
export interface ExpressionPlan {
    continuous?: ContinuousAffectState;
    ruleVersion: string;
    principalId: string;
    personalityRevisionId: string;
    stateRevision: number;
    mode: TaskMode;
    stance: 'neutral' | 'interested' | 'supportive' | 'guarded' | 'hurt' | 'firm';
    ease: number;
    openness: number;
    warmth: number;
    directness: number;
    playfulness: number;
    reserve: number;
    conscientiousness: number;
    curiosity: number;
    optimism: number;
    targetSentences: {
        min: number;
        max: number;
    } | null;
    addressHabitId: string | null;
    allowedMemeIds: string[];
    forbiddenAddresses?: string[];
    restrictedMemes?: string[];
    requiredFacts: string[];
    sourceIds: string[];
    protectedSpans: {
        kind: 'code' | 'quote' | 'url' | 'literal';
        text: string;
    }[];
    ruleIds: string[];
    reasonCodes: string[];
}
export declare function projectExpression(input: {
    state: AffectSnapshot;
    userText: string;
    nowMs: number;
    profile?: PersonalityProfile;
    previous?: ExpressionPlan;
    contactExposure?: {
        messages: number;
        days: number;
    };
}): ExpressionPlan;
