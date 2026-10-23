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
import { partsInZone } from '../domain/time-parse.js'
import type { Repositories } from '../storage/repositories.js'

export type CandidateKind = 'reminder' | 'open_topic' | 'repair' | 'small_talk'

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
    const secondsOfDay = (parts.hour * 60 + parts.minute) * 60 + parts.second
    // 只用整数秒偏移，毫秒部分保留：offset 不会跨越不存在的墙钟时间。
    return nowMs - secondsOfDay * 1000
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

    if (!config.proactive.enabled) blocked.push('proactive-disabled')

    if (inQuietHours(nowMs, config.proactive.timezone, config.proactive.quietStart, config.proactive.quietEnd)) {
        blocked.push('quiet-hours')
    }

    if (input.mainTurnInFlight === true) blocked.push('main-turn-in-flight')

    const dailySince = startOfDayMs(nowMs, config.proactive.timezone)
    const sentToday = repos.countOutboxSince(conversationId, dailySince)
    if (sentToday >= config.proactive.spontaneousLimitPerDay) blocked.push('daily-limit')

    const last = input.lastProactiveAtMs
    if (last !== undefined) {
        const gapMs = config.proactive.spontaneousMinGapMinutes * 60_000
        if (nowMs - last < gapMs) blocked.push('cooldown')
    }

    // 「发出去没回」就暂停：只看主动消息，不把用户正常回复算成未回复。
    const unresolved = repos.unresolvedOutbox(conversationId, nowMs - 7 * 24 * 60 * 60_000)
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
        if (status !== 'confirmed' && status !== 'proposed') continue
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
        key: `repair:${input.conversationId}:${Math.floor(input.nowMs / (60 * 60_000))}`,
        kind: 'repair',
        topic: '上一次争执还没收尾，用一句具体的话把话头递回去，不要反复要求道歉',
        taskId: null,
        scores: { relevance: 0.9, openness: 0.9, relationship: -0.2, initiative: 0.8, interruption: 0.7 },
        reasons: ['存在未结冲突 episode', '关系不满超过阈值'],
        mustSendByMs: null,
    }]
}

function smallTalkCandidate(input: CandidateInput): Candidate[] {
    const { nowMs, conversationId, affection, grievance } = input
    const affectionValue = affection ?? 0.5
    const grievanceValue = grievance ?? 0
    // 关系越差，闲聊越少；这是「降低倾向」，不是硬禁止。
    const relationship = affectionValue - grievanceValue
    if (relationship < 0.25) return []
    // 没有真实话题线索时不编造「看到你刚下班」这类无依据内容（§14.1）。
    return [{
        key: `small:${conversationId}:${Math.floor(nowMs / (6 * 60 * 60_000))}`,
        kind: 'small_talk',
        topic: '没有新事实可说的日常开场：只允许基于本会话里真实发生过的共同话题',
        taskId: null,
        scores: {
            relevance: 0.2,
            openness: 0.3,
            relationship: Math.max(0, Math.min(1, relationship)),
            initiative: 0.4,
            interruption: 0.8,
        },
        reasons: ['关系允许轻松开口', '没有必须说的具体事'],
        mustSendByMs: null,
    }]
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
    const gate = checkGates(input)
    if (!gate.ok) return { gate, candidates: [], selected: null }

    const all = [
        ...reminderCandidates(input),
        ...openTopicCandidates(input),
        ...repairCandidate(input),
        ...smallTalkCandidate(input),
    ]
    const order: Record<CandidateKind, number> = { reminder: 0, open_topic: 1, repair: 2, small_talk: 3 }
    all.sort((a, b) => {
        const kindDiff = order[a.kind] - order[b.kind]
        if (kindDiff !== 0) return kindDiff
        const scoreDiff = rankScore(b) - rankScore(a)
        if (Math.abs(scoreDiff) > 1e-9) return scoreDiff
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })

    return { gate, candidates: all, selected: all[0] ?? null }
}
