import type { Config } from '../config.js';
import type { ContinuousAffectState } from '../domain/continuous-affect.js';
import type { Repositories } from './repositories.js';
export interface EmotionTimelineRevision {
    id: string;
    revision: number;
    status: string;
    recordedAtMs: number;
    vectorJson: string;
    vectorTruncated: boolean;
}
export interface EmotionTimelineAppraisal {
    id: string;
    revision: number;
    status: string;
    evidenceQuote: string;
    vectorJson: string;
    vectorTruncated: boolean;
    revisions: EmotionTimelineRevision[];
    revisionHistoryTotal: number;
    revisionHistoryTruncated: boolean;
}
export interface EmotionTimelinePoint {
    sourceMessageId: string;
    conversationId: string;
    sourceSeq: number;
    occurredAtMs: number;
    sourceText: string;
    sourceTextTruncated: boolean;
    sameTimeSourceCount: number;
    appraisals: EmotionTimelineAppraisal[];
    state: ContinuousAffectState | null;
}
export interface EmotionTimeline {
    version: 'emotion-timeline-v1';
    projection: 'current-valid-evidence';
    sameTimeRule: 'whole-millisecond';
    generatedAtMs: number;
    limit: number;
    hasMore: boolean;
    points: EmotionTimelinePoint[];
}
/** A read-only explanation rebuilt from current evidence, never a stored historical snapshot. */
export declare function emotionTimeline(repos: Repositories, config: Config, principalId: string, nowMs: number, requestedLimit?: number): EmotionTimeline;
