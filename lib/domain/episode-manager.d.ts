/**
 * 关系 episode 管理（任务书 §8.7 / §8.8 / §10.1）。
 *
 * 一个 episode = 一段有来源、有累计效果、可被修复事件推进的冲突/和解。
 * 关键不变量：
 *   - applied_deltas 记录「已经真实施加到关系上的累计值」，更新时只应用差额；
 *   - 解决（resolved）不等于忘记：原文与记忆保留，只是不再作为「未了结」提示；
 *   - 归档（archived）只由显著性衰减或用户删除触发。
 */
import type { EpisodeRecord, RelationshipDelta } from './types.js';
export declare const EPISODE_STATUSES: readonly ["open", "repairing", "resolved", "archived"];
export interface EpisodeMutation {
    record: EpisodeRecord;
    isNew: boolean;
}
export declare function emptyDelta(): RelationshipDelta;
export declare function addDelta(a: RelationshipDelta, b: RelationshipDelta): RelationshipDelta;
export declare function deltaDifference(desired: RelationshipDelta, applied: RelationshipDelta): RelationshipDelta;
export declare function isUnresolved(episode: EpisodeRecord): boolean;
/**
 * 选择可以合并的 episode：同 principal、未解决、同类冲突、落在间隔窗口内。
 * 调用方传入的候选已按 last_event_at_ms 倒序。
 */
export declare function selectMergeTarget(candidates: readonly EpisodeRecord[], nowMs: number, gapMinutes: number): EpisodeRecord | undefined;
export type EpisodeTransition = 'open' | 'repairing' | 'resolved' | 'archived';
/**
 * 状态机：open -repair-> repairing -(再次冒犯)-> open -(确认解决)-> resolved
 * 任何状态都可被用户删除推到 archived。非法转换抛错而不是静默忽略。
 */
export declare function transition(current: EpisodeRecord, next: EpisodeTransition, nowMs: number, summary?: string): EpisodeRecord;
/** 未了结 episode 的简报：只给「有事没解决」的提示，不重复细节。 */
export declare function episodeHint(episodes: readonly EpisodeRecord[], limit?: number): string;
/** 冲突严重度是否足以在上下文里被提起。 */
export declare function worthMentioning(episode: EpisodeRecord): boolean;
