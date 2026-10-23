/**
 * 配置解析（任务书 §16.1）。
 *
 * 不引入 schemastery 等外部依赖：宿主 patch 层把 config 作为普通对象传进来，
 * 这里给出**可读的字段级错误**，绝不静默回落到不安全的空值。
 */
export type PresetId = 'irritable' | 'balanced' | 'gentle';
export type CompanionScope = 'owner_private' | 'owner_all';
export type DeliveryMode = 'bridge' | 'early';
export interface CompanionConfig {
    id: string;
    name: string;
    preset: PresetId;
    scope: CompanionScope;
}
export interface GenerationConfig {
    mode: 'companion' | 'plain';
    liveModelCalls: number;
    thinking: 'disabled' | 'default';
    protocolVersion: number;
    sendOnSayClose: boolean;
    deliveryMode: DeliveryMode;
    metadataTargetTokens: number;
    metadataHardLimitTokens: number;
    plainTextFallback: boolean;
}
export interface MemoryConfig {
    backend: 'sqlite';
    preserveRawText: boolean;
    inputHardLimitTokens: number;
    stateBudgetTokens: number;
    retrievalAndCheckpointBudgetTokens: number;
    candidateLimit: number;
    selectedLimit: number;
    retrievalDeadlineMs: number;
    emotionBonusMax: number;
    factualQueryEmotionBonus: number;
    embeddingEnabled: boolean;
    migrationMode: 'backup_then_migrate' | 'migrate_only';
}
export interface AffectConfig {
    ruleVersion: string;
    hostileConfidenceThreshold: number;
    conflictEpisodeGapMinutes: number;
    silenceChangesRelationship: boolean;
    allowNegativeRelationship: boolean;
    retortIntensity: 'mild' | 'moderate' | 'strong';
    halfLifeMinutes: Record<'anger' | 'hurt' | 'joy' | 'tension' | 'expressiveness', number>;
    dailyAbsoluteDeltaCaps: Record<'affection' | 'trust' | 'respect' | 'grievance', number>;
}
export interface ProactiveConfig {
    enabled: boolean;
    timezone: string;
    quietStart: string;
    quietEnd: string;
    checkMinutes: number;
    spontaneousLimitPerDay: number;
    spontaneousMinGapMinutes: number;
    pauseAfterUnanswered: number;
    maxGenerationCallsPerCandidate: number;
}
export interface BackgroundConfig {
    consolidateEveryTurns: number;
    inputLimitTokens: number;
    outputLimitTokens: number;
    maxConcurrentJobs: number;
    priority: 'low';
    retryLimit: number;
}
export interface StorageConfig {
    directory: string;
    backupDaily: boolean;
    backupRetentionDays: number;
    busyTimeoutMs: number;
}
export interface ObservabilityConfig {
    includeMessageContentByDefault: boolean;
    retainProviderUsage: boolean;
    retainStateRevisionAndReasonCodes: boolean;
}
export interface ChannelConfig {
    /** dsh-onebot-qq 写出的 chat→session 映射；相对路径按 dsh home 解析。 */
    chatSessionsFile: string;
    /** 允许启用陪伴行为的私聊 chatId（private:<qq>）。空数组 = 不启用任何会话。 */
    ownerChats: string[];
    /** 群聊扩展默认关闭：未显式启用的群不注入本人记忆与情感。 */
    enabledGroupChats: string[];
    /** NapCat / OneBot 11 HTTP 端点，仅在需要插件自己发送（主动消息）时使用。 */
    onebotHttpBase: string;
    accessToken: string;
}
export interface IntegrationConfig {
    enabled: boolean;
    mode: 'augment' | 'standalone';
    localOwner: boolean;
    excludedAgentIds: string[];
    contextBudgetTokens: number;
}
export interface Config {
    integration: IntegrationConfig;
    companion: CompanionConfig;
    generation: GenerationConfig;
    memory: MemoryConfig;
    affect: AffectConfig;
    proactive: ProactiveConfig;
    background: BackgroundConfig;
    storage: StorageConfig;
    observability: ObservabilityConfig;
    channel: ChannelConfig;
}
export declare function dshHome(): string;
export declare const DEFAULT_CONFIG: Config;
export declare class ConfigError extends Error {
    readonly field: string;
    constructor(field: string, message: string);
}
type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
/**
 * 把 patch 层传入的原始对象解析成完整配置。任何非法字段抛 ConfigError，
 * 调用方（apply）负责把它变成一条可读的加载失败日志。
 */
export declare function resolveConfig(raw?: unknown): Config;
/** 脱敏后的配置快照，用于 docs/ENVIRONMENT.md 与 doctor 输出。 */
export declare function redactConfig(config: Config): Record<string, Json>;
export declare function maskId(id: string): string;
export {};
