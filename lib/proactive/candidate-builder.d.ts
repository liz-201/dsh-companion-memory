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
import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
export type CandidateKind = 'reminder' | 'open_topic' | 'repair' | 'small_talk' | 'follow_up' | 'interest_share' | 'positive_revisit' | 'shared_topic';
export interface Candidate {
    /** 稳定键：同一候选重复扫描不会重复入队（outbox.candidate_key 唯一）。 */
    key: string;
    kind: CandidateKind;
    /** 生成时给模型的话题线索；不是最终发出的正文。 */
    topic: string;
    taskId: string | null;
    /** 参与排序的分项分数，便于解释。 */
    scores: Record<string, number>;
    reasons: string[];
    /** 指定时刻的提醒不允许被「话题相关度」压掉。 */
    mustSendByMs: number | null;
}
export interface GateResult {
    ok: boolean;
    /** 不通过的原因；ok=true 时为空。 */
    blocked: string[];
    /** 通过但需要注意的事实（例如临近静默时段）。 */
    notes: string[];
}
export interface CandidateInput {
    config: Config;
    repos: Repositories;
    conversationId: string;
    principalId: string;
    nowMs: number;
    /** 主回合是否在跑（由适配层传入，避免主动消息插队）。 */
    mainTurnInFlight?: boolean;
    /** 上一次主动消息的发送时间；undefined 表示没有。 */
    lastProactiveAtMs?: number | undefined;
    /** 关系状态：不满越高，闲聊倾向越低（§14.2）。 */
    grievance?: number;
    affection?: number;
    /** 是否有未结冲突 episode（只有真的吵过才允许「接地气」的修复开场）。 */
    unresolvedConflict?: boolean;
}
export interface CandidateResult {
    gate: GateResult;
    candidates: Candidate[];
    /** 本轮选中的一条；没有候选或闸门未过时为 null。 */
    selected: Candidate | null;
}
/** "23:00" / "08:30" → 分钟数；非法返回 null。 */
export declare function parseClock(text: string): number | null;
/** 当前是否落在静默时段（支持跨零点，例如 23:00–08:30）。 */
export declare function inQuietHours(nowMs: number, timezone: string, quietStart: string, quietEnd: string): boolean;
/** 当天 0 点（用户时区）的毫秒时间戳，用于日限额统计。 */
export declare function startOfDayMs(nowMs: number, timezone: string): number;
/**
 * 硬闸门。任何一条不满足就整体返回 blocked，调用方据此不生成、不入队。
 *
 * 注意：这里不判断「该不该说话」的语气问题，只管客观条件。
 */
export declare function checkGates(input: CandidateInput): GateResult;
/** 排序权重（§14.2 顺序）：相关度 > 未结 > 关系 > 主动性 > 打扰成本（负向）。 */
export declare function rankScore(candidate: Candidate): number;
/**
 * 构建候选并选出唯一一条。
 *
 * 明确提醒优先于一切；其次未结话题；再是修复；最后才是闲聊。
 * 同类内部按 rankScore 排序，分值相同按 key 稳定排序（测试可复现）。
 */
export declare function buildCandidates(input: CandidateInput): CandidateResult;
