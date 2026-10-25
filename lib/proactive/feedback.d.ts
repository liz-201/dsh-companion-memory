import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding, RawMessage } from '../domain/types.js';
export type FeedbackKind = 'positive' | 'negative' | 'busy' | 'explicit_preference' | 'unrelated' | 'unknown';
export declare function classifyFeedback(text: string): FeedbackKind;
export declare function observeFeedback(repos: Repositories, binding: IdentityBinding, message: RawMessage): void;
export declare function topicAcceptance(repos: Repositories, principalId: string, category: string, nowMs: number, timezone: string): number;
export declare function feedbackAcceptance(rows: readonly {
    kind: FeedbackKind;
}[]): number;
