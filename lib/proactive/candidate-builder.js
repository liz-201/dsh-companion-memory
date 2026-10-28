import { partsInZone, zonedToUtc } from '../domain/time-parse.js';
import { opportunityScore } from './opportunity.js';
import { topicAcceptance } from './feedback.js';
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js';
import { proactiveFrequency } from './frequency.js';
import { computerEvidence } from './computer-evidence.js';
/** "23:00" / "08:30" → 分钟数；非法返回 null。 */
export function parseClock(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (match === null)
        return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute))
        return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return null;
    return hour * 60 + minute;
}
/** 当前是否落在静默时段（支持跨零点，例如 23:00–08:30）。 */
export function inQuietHours(nowMs, timezone, quietStart, quietEnd) {
    const start = parseClock(quietStart);
    const end = parseClock(quietEnd);
    if (start === null || end === null)
        return false;
    const parts = partsInZone(nowMs, timezone);
    const now = parts.hour * 60 + parts.minute;
    if (start === end)
        return false;
    return start < end ? now >= start && now < end : now >= start || now < end;
}
/** 当天 0 点（用户时区）的毫秒时间戳，用于日限额统计。 */
export function startOfDayMs(nowMs, timezone) {
    const parts = partsInZone(nowMs, timezone);
    return zonedToUtc(parts.year, parts.month, parts.day, 0, 0, timezone);
}
function str(row, key) {
    const value = row[key];
    return typeof value === 'string' ? value : null;
}
function num(row, key) {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/**
 * 硬闸门。任何一条不满足就整体返回 blocked，调用方据此不生成、不入队。
 *
 * 注意：这里不判断「该不该说话」的语气问题，只管客观条件。
 */
export function checkGates(input) {
    const { config, repos, conversationId, nowMs } = input;
    const blocked = [];
    const notes = [];
    if ((repos.getSetting('proactive.enabled') ?? (config.proactive.enabled ? '1' : '0')) !== '1')
        blocked.push('proactive-disabled');
    const ownership = repos.db.get('SELECT active_device_id, conflict_json FROM proactive_ownership WHERE companion_id = ?', config.companion.id);
    if (ownership && (ownership.conflict_json || ownership.active_device_id !== repos.getSetting('local.device-id')))
        blocked.push('inactive-device');
    if (inQuietHours(nowMs, config.proactive.timezone, config.proactive.quietStart, config.proactive.quietEnd)) {
        blocked.push('quiet-hours');
    }
    if (input.mainTurnInFlight === true)
        blocked.push('main-turn-in-flight');
    if (config.computerEvents.enabled || config.perception.enabled) {
        let sample = {};
        try {
            sample = JSON.parse(repos.getSetting('local.notification-state') ?? '{}');
        }
        catch { }
        if (sample.state !== 'accepts' || !sample.at || nowMs - sample.at > Math.max(120000, config.computerEvents.pollSeconds * 2000) || sample.at > nowMs)
            blocked.push('notification-unavailable');
    }
    if (Number(repos.getSetting(`proactive.snooze-until:${input.principalId}`) ?? 0) > nowMs)
        blocked.push('user-busy');
    const dailySince = startOfDayMs(nowMs, config.proactive.timezone);
    const frequency = proactiveFrequency(config, repos, input.principalId, nowMs);
    const sentToday = repos.countOutboxSince(conversationId, dailySince);
    if (sentToday >= frequency.dailyLimit)
        blocked.push('daily-limit');
    const globalCount = Number(repos.db.get(`SELECT COUNT(*) AS n FROM outbox WHERE ${SPONTANEOUS_OUTBOX} AND planned_at_ms >= ? AND status IN ('pending','sending','sent','unknown')`, dailySince)?.n ?? 0);
    if (globalCount >= frequency.dailyLimit)
        blocked.push('global-daily-limit');
    const latestDelivery = repos.db.get(`SELECT COALESCE(sent_at_ms, planned_at_ms) AS at FROM outbox WHERE ${SPONTANEOUS_OUTBOX} AND status IN ('sent','unknown') ORDER BY at DESC LIMIT 1`);
    const last = input.lastProactiveAtMs === undefined ? latestDelivery?.at : Math.max(input.lastProactiveAtMs, latestDelivery?.at ?? 0);
    if (last !== undefined) {
        const gapMs = frequency.minGapMinutes * 60_000;
        if (nowMs - last < gapMs)
            blocked.push('cooldown');
    }
    // 「发出去没回」就暂停：只看主动消息，不把用户正常回复算成未回复。
    const unresolved = repos.unresolvedOutbox(conversationId, 0);
    if (unresolved.length >= config.proactive.pauseAfterUnanswered)
        blocked.push('awaiting-reply');
    if (blocked.length === 0 && sentToday > 0)
        notes.push(`今日已主动 ${sentToday} 条`);
    return { ok: blocked.length === 0, blocked, notes };
}
function reminderCandidates(input) {
    const { repos, config, nowMs, conversationId } = input;
    const rows = repos.dueTasks(nowMs, 20).filter(row => str(row, 'conversation_id') === conversationId);
    const out = [];
    for (const row of rows) {
        const status = str(row, 'status');
        if (status !== 'confirmed')
            continue;
        const kind = str(row, 'kind');
        if (kind !== 'reminder')
            continue;
        const id = str(row, 'id');
        const content = str(row, 'content');
        if (id === null || content === null)
            continue;
        const expires = num(row, 'expires_at_ms');
        if (expires !== null && expires <= nowMs) {
            // 过期提醒不再主动说，但也不静默删除：由命令层标记 expired。
            continue;
        }
        const due = num(row, 'due_at_ms');
        out.push({
            key: `reminder:${id}`,
            kind: 'reminder',
            topic: content,
            taskId: id,
            scores: { relevance: 1, openness: 1, relationship: 0.5, initiative: 1, interruption: 0.2 },
            reasons: [due === null ? '未给具体时刻的提醒（需确认）' : '到达提醒时刻'],
            mustSendByMs: due,
        });
        void config;
    }
    return out;
}
function openTopicCandidates(input) {
    const { repos, conversationId } = input;
    const rows = repos.pendingTasks(conversationId, 10);
    const out = [];
    for (const row of rows) {
        const kind = str(row, 'kind');
        const status = str(row, 'status');
        if (kind !== 'open_topic' && kind !== 'commitment')
            continue;
        if (status !== 'confirmed' && status !== 'proposed')
            continue;
        const id = str(row, 'id');
        const content = str(row, 'content');
        if (id === null || content === null || content.length === 0)
            continue;
        out.push({
            key: `topic:${id}`,
            kind: 'open_topic',
            topic: content,
            taskId: id,
            scores: {
                relevance: 0.7,
                openness: kind === 'commitment' ? 0.8 : 0.6,
                relationship: 0.5,
                initiative: 0.6,
                interruption: 0.4,
            },
            reasons: [kind === 'commitment' ? '此前答应过的事' : '没聊完的话题'],
            mustSendByMs: null,
        });
    }
    return out;
}
function repairCandidate(input) {
    if (input.unresolvedConflict !== true)
        return [];
    const grievance = input.grievance ?? 0;
    if (grievance < 0.35)
        return [];
    return [{
            key: `repair:${input.conversationId}:${String(input.repos.listEpisodes(input.principalId, ['open', 'repairing'], 1)[0]?.['id'] ?? 'unknown')}`,
            kind: 'repair',
            topic: '上一次争执还没收尾，用一句具体的话把话头递回去，不要反复要求道歉',
            taskId: null,
            scores: { relevance: 0.9, openness: 0.9, relationship: -0.2, initiative: 0.8, interruption: 0.7 },
            reasons: ['存在未结冲突 episode', '关系不满超过阈值'],
            mustSendByMs: null,
        }];
}
function smallTalkCandidate(input) {
    const { repos, conversationId, nowMs } = input;
    repos.db.run("UPDATE proactive_opportunities SET status = 'expired' WHERE status = 'pending' AND expires_at_ms <= ?", nowMs);
    return repos.db.all("SELECT * FROM proactive_opportunities WHERE conversation_id = ? AND status = 'pending' AND not_before_ms <= ? AND expires_at_ms > ? ORDER BY created_at_ms LIMIT 20", conversationId, nowMs, nowMs).filter(row => {
        if (row['kind'] === 'computer_event' && !JSON.parse(String(row['source_ids_json'])).some(id => {
            const evidence = computerEvidence(repos, id, input.principalId, conversationId, nowMs);
            return evidence && (evidence.source === 'interface' ? input.config.perception.enabled : input.config.computerEvents.enabled);
        }))
            return false;
        const blockedSource = repos.getSetting(`proactive.blocked-kind:${input.principalId}:${String(row['kind'])}`);
        if (blockedSource && repos.getRawMessage(blockedSource)?.deletedAtMs === null)
            return false;
        return JSON.parse(String(row['source_ids_json'])).every(id => {
            const blockedBy = repos.getSetting(`proactive.blocked-source:${input.principalId}:${id}`);
            if (blockedBy && repos.getRawMessage(blockedBy)?.deletedAtMs === null)
                return false;
            const raw = repos.getRawMessage(id), memory = repos.getMemory(id);
            return raw && raw.deletedAtMs === null || memory && memory.status === 'active' && memory.principal_id === input.principalId || computerEvidence(repos, id, input.principalId, conversationId, nowMs);
        });
    }).map(row => {
        const state = repos.getSnapshot(input.principalId)?.snapshot;
        const scores = JSON.parse(String(row['scores_json']));
        scores['acceptance'] = topicAcceptance(repos, input.principalId, String(row['kind']), nowMs, input.config.proactive.timezone);
        if (state) {
            scores['initiative'] = state.personality.initiative;
            scores['willingness'] = Math.max(0, Math.min(1, .5 + state.mood.joy * .3 - state.mood.tension * .4 - state.mood.hurt * .4));
        }
        return { key: String(row['id']), kind: row['kind'], topic: String(row['summary']), taskId: null, scores, reasons: [`可追溯来源：${String(row['source_ids_json'])}`], mustSendByMs: null };
    }).filter(candidate => opportunityScore(candidate.scores) >= input.config.proactive.opportunityThreshold);
}
/** 排序权重（§14.2 顺序）：相关度 > 未结 > 关系 > 主动性 > 打扰成本（负向）。 */
export function rankScore(candidate) {
    const s = candidate.scores;
    return (s['relevance'] ?? 0) * 0.35
        + (s['openness'] ?? 0) * 0.25
        + (s['relationship'] ?? 0) * 0.15
        + (s['initiative'] ?? 0) * 0.15
        - (s['interruption'] ?? 0) * 0.10;
}
/**
 * 构建候选并选出唯一一条。
 *
 * 明确提醒优先于一切；其次未结话题；再是修复；最后才是闲聊。
 * 同类内部按 rankScore 排序，分值相同按 key 稳定排序（测试可复现）。
 */
export function buildCandidates(input) {
    // Confirmed reminders have their own permission, schedule and expiry, independent of idle chat.
    const reminders = reminderCandidates(input);
    if (reminders.length > 0 && !input.mainTurnInFlight) {
        return { gate: { ok: true, blocked: [], notes: ['confirmed-reminder'] }, candidates: reminders, selected: reminders[0] ?? null };
    }
    const gate = checkGates(input);
    if (!gate.ok)
        return { gate, candidates: [], selected: null };
    const all = [
        ...reminderCandidates(input),
        ...openTopicCandidates(input),
        ...repairCandidate(input),
        ...smallTalkCandidate(input),
    ];
    all.sort((a, b) => {
        if (a.kind === 'reminder' || b.kind === 'reminder')
            return a.kind === b.kind ? 0 : a.kind === 'reminder' ? -1 : 1;
        const scoreDiff = opportunityScore(b.scores) - opportunityScore(a.scores);
        if (Math.abs(scoreDiff) > 1e-9)
            return scoreDiff;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return { gate, candidates: all, selected: all.find(candidate => opportunityScore(candidate.scores) >= input.config.proactive.opportunityThreshold) ?? null };
}
//# sourceMappingURL=candidate-builder.js.map