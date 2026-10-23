/**
 * 关系 episode 管理（任务书 §8.7 / §8.8 / §10.1）。
 *
 * 一个 episode = 一段有来源、有累计效果、可被修复事件推进的冲突/和解。
 * 关键不变量：
 *   - applied_deltas 记录「已经真实施加到关系上的累计值」，更新时只应用差额；
 *   - 解决（resolved）不等于忘记：原文与记忆保留，只是不再作为「未了结」提示；
 *   - 归档（archived）只由显著性衰减或用户删除触发。
 */
export const EPISODE_STATUSES = ['open', 'repairing', 'resolved', 'archived'];
export function emptyDelta() {
    return { affection: 0, trust: 0, respect: 0, grievance: 0 };
}
export function addDelta(a, b) {
    return {
        affection: a.affection + b.affection,
        trust: a.trust + b.trust,
        respect: a.respect + b.respect,
        grievance: a.grievance + b.grievance,
    };
}
export function deltaDifference(desired, applied) {
    return {
        affection: desired.affection - applied.affection,
        trust: desired.trust - applied.trust,
        respect: desired.respect - applied.respect,
        grievance: desired.grievance - applied.grievance,
    };
}
export function isUnresolved(episode) {
    return episode.status === 'open' || episode.status === 'repairing';
}
/**
 * 选择可以合并的 episode：同 principal、未解决、同类冲突、落在间隔窗口内。
 * 调用方传入的候选已按 last_event_at_ms 倒序。
 */
export function selectMergeTarget(candidates, nowMs, gapMinutes) {
    const gapMs = Math.max(0, gapMinutes) * 60_000;
    for (const candidate of candidates) {
        if (!isUnresolved(candidate))
            continue;
        if (nowMs - candidate.lastEventAtMs > gapMs)
            continue;
        return candidate;
    }
    return undefined;
}
/**
 * 状态机：open -repair-> repairing -(再次冒犯)-> open -(确认解决)-> resolved
 * 任何状态都可被用户删除推到 archived。非法转换抛错而不是静默忽略。
 */
export function transition(current, next, nowMs, summary) {
    const allowed = {
        open: ['repairing', 'resolved', 'archived', 'open'],
        repairing: ['open', 'resolved', 'archived', 'repairing'],
        resolved: ['archived', 'open'],
        archived: [],
    };
    if (!(allowed[current.status] ?? []).includes(next)) {
        throw new Error(`episode ${current.id} 不允许从 ${current.status} 转到 ${next}`);
    }
    return {
        ...current,
        status: next,
        lastEventAtMs: next === 'archived' ? current.lastEventAtMs : nowMs,
        summary: summary ?? current.summary,
    };
}
/** 未了结 episode 的简报：只给「有事没解决」的提示，不重复细节。 */
export function episodeHint(episodes, limit = 2) {
    const unresolved = episodes.filter(isUnresolved).slice(0, limit);
    if (unresolved.length === 0)
        return '没有悬着的事';
    return unresolved
        .map((episode) => `${episode.summary || episode.kind}（${episode.sourceMessageIds.length} 条原始消息）`)
        .join('；');
}
/** 冲突严重度是否足以在上下文里被提起。 */
export function worthMentioning(episode) {
    return isUnresolved(episode) && (Math.abs(episode.appliedDeltas.grievance) >= 0.02 || episode.appliedDeltas.trust <= -0.02);
}
//# sourceMappingURL=episode-manager.js.map