/**
 * 主动消息候选（任务书 §14.1、§14.2、§14.3）。
 *
 * 这个模块只做一件事：在「已经过完硬闸门」的前提下，排出值得主动开口的候选，
 * 并给出**为什么是它**的理由，供 /fish why 与审计使用。它不发送、不调模型、
 * 不写 outbox —— 发送由 outbox-worker 负责，生成由 scheduler 负责。
 *
 * 硬闸门（§14.2，先于任何打分）：
 *   绑定在册 → 主动开关 → 可发送时段 → 日限额 → 冷却 → 未回复暂停 →
 *   没有更新的用户消息 → 主回合不在跑 → 任务未取消/未过期。
 * 任何一条不满足就整体返回空候选，不做「凑一条」。
 *
 * 排序（§14.2）：话题相关度 → 未结程度 → 关系状态 → 主动性 → 打扰成本。
 * 明确提醒永远先于闲聊；闲聊不因「久没说话」自动升级为必须发送。
 */
import type { Config } from '../config.js'
import type { TaskKind } from '../domain/types.js'
import { partsInZone, zonedToUtc } from '../domain/time-parse.js'
import type { Repositories } from '../storage/repositories.js'
import { opportunityScore } from './opportunity.js'
import { topicAcceptance } from './feedback.js'
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js'
import { proactiveFrequency } from './frequency.js'
import { computerEvidence } from './computer-evidence.js'

export type CandidateKind = 'reminder' | 'open_topic' | 'repair' | 'small_talk' | 'follow_up' | 'interest_share' | 'positive_revisit' | 'shared_topic' | 'computer_event'

export interface Candidate {
    /** 稳定键：同一候选重复扫描不会重复入队（outbox.candidate_key 唯一）。 */
    key: string
    kind: CandidateKind
    /** 生成时给模型的话题线索；不是最终发出的正文。 */
    topic: string
    taskId: string | null
    /** 参与排序的分项分数，便于解释。 */
    scores: Record<string, number>
    reasons: string[]
    /** 指定时刻的提醒不允许被「话题相关度」压掉。 */
    mustSendByMs: number | null
}

export interface GateResult {
    ok: boolean
    /** 不通过的原因；ok=true 时为空。 */
    blocked: string[]
    /** 通过但需要注意的事实（例如临近静默时段）。 */
    notes: string[]
}

export interface CandidateInput {
    config: Config
    repos: Repositories
    conversationId: string
    principalId: string
    nowMs: number
    /** 主回合是否在跑（由适配层传入，避免主动消息插队）。 */
    mainTurnInFlight?: boolean
    /** 上一次主动消息的发送时间；undefined 表示没有。 */
    lastProactiveAtMs?: number | undefined
    /** 关系状态：不满越高，闲聊倾向越低（§14.2）。 */
    grievance?: number
    affection?: number
    /** 是否有未结冲突 episode（只有真的吵过才允许「接地气」的修复开场）。 */
    unresolvedConflict?: boolean
}

export interface CandidateResult {
    gate: GateResult
    candidates: Candidate[]
    /** 本轮选中的一条；没有候选或闸门未过时为 null。 */
    selected: Candidate | null
}

/** "23:00" / "08:30" → 分钟数；非法返回 null。 */
export function parseClock(text: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
    if (match === null) return null
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return hour * 60 + minute
}

/** 当前是否落在静默时段（支持跨零点，例如 23:00–08:30）。 */
export function inQuietHours(nowMs: number, timezone: string, quietStart: string, quietEnd: string): boolean {
    const start = parseClock(quietStart)
    const end = parseClock(quietEnd)
    if (start === null || end === null) return false
    const parts = partsInZone(nowMs, timezone)
    const now = parts.hour * 60 + parts.minute
    if (start === end) return false
    return start < end ? now >= start && now < end : now >= start || now < end
}

/** 当天 0 点（用户时区）的毫秒时间戳，用于日限额统计。 */
export function startOfDayMs(nowMs: number, timezone: string): number {
    const parts = partsInZone(nowMs, timezone)
    return zonedToUtc(parts.year, parts.month, parts.day, 0, 0, timezone)
}

function str(row: Record<string, unknown>, key: string): string | null {
    const value = row[key]
    return typeof value === 'string' ? value : null
}

function num(row: Record<string, unknown>, key: string): number | null {
    const value = row[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 硬闸门。任何一条不满足就整体返回 blocked，调用方据此不生成、不入队。
 *
 * 注意：这里不判断「该不该说话」的语气问题，只管客观条件。
 */
export function checkGates(input: CandidateInput): GateResult {
    const { config, repos, conversationId, nowMs } = input
    const blocked: string[] = []
    const notes: string[] = []

    if ((repos.getSetting('proactive.enabled') ?? (config.proactive.enabled ? '1' : '0')) !== '1') blocked.push('proactive-disabled')
    const ownership = repos.db.get<{ active_device_id: string; conflict_json: string | null }>('SELECT active_device_id, conflict_json FROM proactive_ownership WHERE companion_id = ?', config.companion.id)
    if (ownership && (ownership.conflict_json || ownership.active_device_id !== repos.getSetting('local.device-id'))) blocked.push('inactive-device')

    if (inQuietHours(nowMs, config.proactive.timezone, config.proactive.quietStart, config.proactive.quietEnd)) {
        blocked.push('quiet-hours')
    }

    if (input.mainTurnInFlight === true) blocked.push('main-turn-in-flight')
    if (Number(repos.getSetting(`proactive.snooze-until:${input.principalId}`) ?? 0) > nowMs) blocked.push('user-busy')

    const dailySince = startOfDayMs(nowMs, config.proactive.timezone)
    const frequency = proactiveFrequency(config, repos, input.principalId)
    const sentToday = repos.countOutboxSince(conversationId, dailySince)
    if (sentToday >= frequency.dailyLimit) blocked.push('daily-limit')
    const globalCount = Number(repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE ${SPONTANEOUS_OUTBOX} AND planned_at_ms >= ? AND status IN ('pending','sending','sent','unknown')`, dailySince)?.n ?? 0)
    if (globalCount >= frequency.dailyLimit) blocked.push('global-daily-limit')

    const latestDelivery = repos.db.get<{ at: number }>(`SELECT COALESCE(sent_at_ms, planned_at_ms) AS at FROM outbox WHERE ${SPONTANEOUS_OUTBOX} AND status IN ('sent','unknown') ORDER BY at DESC LIMIT 1`)
    const last = input.lastProactiveAtMs === undefined ? latestDelivery?.at : Math.max(input.lastProactiveAtMs, latestDelivery?.at ?? 0)
    if (last !== undefined) {
        const gapMs = frequency.minGapMinutes * 60_000
        if (nowMs - last < gapMs) blocked.push('cooldown')
    }

    // 「发出去没回」就暂停：只看主动消息，不把用户正常回复算成未回复。
    const unresolved = repos.unresolvedOutbox(conversationId, 0)
    if (unresolved.length >= config.proactive.pauseAfterUnanswered) blocked.push('awaiting-reply')

    if (blocked.length === 0 && sentToday > 0) notes.push(`今日已主动 ${sentToday} 条`)

    return { ok: blocked.length === 0, blocked, notes }
}

function reminderCandidates(input: CandidateInput): Candidate[] {
    const { repos, config, nowMs, conversationId } = input
    const rows = repos.dueTasks(nowMs, 20).filter(row => str(row, 'conversation_id') === conversationId)
    const out: Candidate[] = []
    for (const row of rows) {
        const status = str(row, 'status')
        if (status !== 'confirmed') continue
        const kind = str(row, 'kind') as TaskKind | null
        if (kind !== 'reminder') continue
        const id = str(row, 'id')
        const content = str(row, 'content')
        if (id === null || content === null) continue
        const expires = num(row, 'expires_at_ms')
        if (expires !== null && expires <= nowMs) {
            // 过期提醒不再主动说，但也不静默删除：由命令层标记 expired。
            continue
        }
        const due = num(row, 'due_at_ms')
        out.push({
            key: `reminder:${id}`,
            kind: 'reminder',
            topic: content,
            taskId: id,
            scores: { relevance: 1, openness: 1, relationship: 0.5, initiative: 1, interruption: 0.2 },
            reasons: [due === null ? '未给具体时刻的提醒（需确认）' : '到达提醒时刻'],
            mustSendByMs: due,
        })
        void config
    }
    return out
}

function openTopicCandidates(input: CandidateInput): Candidate[] {
    const { repos, conversationId } = input
    const rows = repos.pendingTasks(conversationId, 10)
    const out: Candidate[] = []
    for (const row of rows) {
        const kind = str(row, 'kind')
        const status = str(row, 'status')
        if (kind !== 'open_topic' && kind !== 'commitment') continue
        if (status !== 'confirmed' && status !== 'proposed') continue
        const id = str(row, 'id')
        const content = str(row, 'content')
        if (id === null || content === null || content.length === 0) continue
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
        })
    }
    return out
}

function repairCandidate(input: CandidateInput): Candidate[] {
    if (input.unresolvedConflict !== true) return []
    const grievance = input.grievance ?? 0
    if (grievance < 0.35) return []
    return [{
        key: `repair:${input.conversationId}:${String(input.repos.listEpisodes(input.principalId, ['open', 'repairing'], 1)[0]?.['id'] ?? 'unknown')}`,
        kind: 'repair',
        topic: '上一次争执还没收尾，用一句具体的话把话头递回去，不要反复要求道歉',
        taskId: null,
        scores: { relevance: 0.9, openness: 0.9, relationship: -0.2, initiative: 0.8, interruption: 0.7 },
        reasons: ['存在未结冲突 episode', '关系不满超过阈值'],
        mustSendByMs: null,
    }]
}

function smallTalkCandidate(input: CandidateInput): Candidate[] {
    const { repos, conversationId, nowMs } = input
    repos.db.run("UPDATE proactive_opportunities SET status = 'expired' WHERE status = 'pending' AND expires_at_ms <= ?", nowMs)
    return repos.db.all<Record<string, unknown>>("SELECT * FROM proactive_opportunities WHERE conversation_id = ? AND status = 'pending' AND not_before_ms <= ? AND expires_at_ms > ? ORDER BY created_at_ms LIMIT 20", conversationId, nowMs, nowMs).filter(row => {
      if (row['kind'] === 'computer_event' && !input.config.computerEvents.enabled) return false
      const blockedSource = repos.getSetting(`proactive.blocked-kind:${input.principalId}:${String(row['kind'])}`)
      if (blockedSource && repos.getRawMessage(blockedSource)?.deletedAtMs === null) return false
      return (JSON.parse(String(row['source_ids_json'])) as string[]).every(id => {
        const blockedBy = repos.getSetting(`proactive.blocked-source:${input.principalId}:${id}`)
        if (blockedBy && repos.getRawMessage(blockedBy)?.deletedAtMs === null) return false
        const raw = repos.getRawMessage(id), memory = repos.getMemory(id)
        return raw && raw.deletedAtMs === null || memory && memory.status === 'active' && memory.principal_id === input.principalId || computerEvidence(repos, id, input.principalId, conversationId, nowMs)
      })
    }).map(row => {
      const state = repos.getSnapshot(input.principalId)?.snapshot
      const scores = JSON.parse(String(row['scores_json'])) as Record<string, number>
      scores['acceptance'] = topicAcceptance(repos, input.principalId, String(row['kind']), nowMs, input.config.proactive.timezone)
      if (state) { scores['initiative'] = state.personality.initiative; scores['willingness'] = Math.max(0, Math.min(1, .5 + state.mood.joy * .3 - state.mood.tension * .4 - state.mood.hurt * .4)) }
      return { key: String(row['id']), kind: row['kind'] as CandidateKind, topic: String(row['summary']), taskId: null, scores, reasons: [`可追溯来源：${String(row['source_ids_json'])}`], mustSendByMs: null }
    }).filter(candidate => opportunityScore(candidate.scores) >= input.config.proactive.opportunityThreshold)
}

/** 排序权重（§14.2 顺序）：相关度 > 未结 > 关系 > 主动性 > 打扰成本（负向）。 */
export function rankScore(candidate: Candidate): number {
    const s = candidate.scores
    return (s['relevance'] ?? 0) * 0.35
        + (s['openness'] ?? 0) * 0.25
        + (s['relationship'] ?? 0) * 0.15
        + (s['initiative'] ?? 0) * 0.15
        - (s['interruption'] ?? 0) * 0.10
}

/**
 * 构建候选并选出唯一一条。
 *
 * 明确提醒优先于一切；其次未结话题；再是修复；最后才是闲聊。
 * 同类内部按 rankScore 排序，分值相同按 key 稳定排序（测试可复现）。
 */
export function buildCandidates(input: CandidateInput): CandidateResult {
    // Confirmed reminders have their own permission, schedule and expiry, independent of idle chat.
    const reminders = reminderCandidates(input)
    if (reminders.length > 0 && !input.mainTurnInFlight) {
        return { gate: { ok: true, blocked: [], notes: ['confirmed-reminder'] }, candidates: reminders, selected: reminders[0] ?? null }
    }
    const gate = checkGates(input)
    if (!gate.ok) return { gate, candidates: [], selected: null }

    const all = [
        ...reminderCandidates(input),
        ...openTopicCandidates(input),
        ...repairCandidate(input),
        ...smallTalkCandidate(input),
    ]
    all.sort((a, b) => {
        if (a.kind === 'reminder' || b.kind === 'reminder') return a.kind === b.kind ? 0 : a.kind === 'reminder' ? -1 : 1
        const scoreDiff = opportunityScore(b.scores) - opportunityScore(a.scores)
        if (Math.abs(scoreDiff) > 1e-9) return scoreDiff
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })

    return { gate, candidates: all, selected: all.find(candidate => opportunityScore(candidate.scores) >= input.config.proactive.opportunityThreshold) ?? null }
}
