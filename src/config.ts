/**
 * 配置解析（任务书 §16.1）。
 *
 * 不引入 schemastery 等外部依赖：宿主 patch 层把 config 作为普通对象传进来，
 * 这里给出**可读的字段级错误**，绝不静默回落到不安全的空值。
 */

import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { validatePersonality, type PersonalityOptions } from './domain/personality-profile.js'
import { MIN_EXPRESSION_BUDGET } from './expression/policy.js'

export type PresetId = 'irritable' | 'balanced' | 'gentle'
export type CompanionScope = 'owner_private' | 'owner_all'
export type DeliveryMode = 'bridge' | 'early'

export interface CompanionConfig {
  id: string
  name: string
  preset: PresetId
  scope: CompanionScope
}

export interface GenerationConfig {
  mode: 'companion' | 'plain'
  liveModelCalls: number
  thinking: 'disabled' | 'default'
  protocolVersion: number
  sendOnSayClose: boolean
  deliveryMode: DeliveryMode
  metadataTargetTokens: number
  metadataHardLimitTokens: number
  plainTextFallback: boolean
}

export interface MemoryConfig {
  backend: 'sqlite'
  preserveRawText: boolean
  inputHardLimitTokens: number
  stateBudgetTokens: number
  retrievalAndCheckpointBudgetTokens: number
  candidateLimit: number
  selectedLimit: number
  retrievalDeadlineMs: number
  emotionBonusMax: number
  factualQueryEmotionBonus: number
  embeddingEnabled: boolean
  migrationMode: 'backup_then_migrate' | 'migrate_only'
}

export interface AffectConfig {
  ruleVersion: string
  hostileConfidenceThreshold: number
  conflictEpisodeGapMinutes: number
  silenceChangesRelationship: boolean
  allowNegativeRelationship: boolean
  retortIntensity: 'mild' | 'moderate' | 'strong'
  halfLifeMinutes: Record<'anger' | 'hurt' | 'joy' | 'tension' | 'expressiveness', number>
  dailyAbsoluteDeltaCaps: Record<'affection' | 'trust' | 'respect' | 'grievance', number>
}

export interface ProactiveConfig {
  adaptiveFrequency: boolean
  adaptiveMaxDailyLimit: number
  adaptiveMinGapMinutes: number
  modelInterests: string[]
  opportunityThreshold: number
  shareSources: string[]
  enabled: boolean
  timezone: string
  quietStart: string
  quietEnd: string
  checkMinutes: number
  spontaneousLimitPerDay: number
  spontaneousMinGapMinutes: number
  pauseAfterUnanswered: number
  maxGenerationCallsPerCandidate: number
}

export interface ComputerEventsConfig {
  enabled: boolean
  pollSeconds: number
  idleThresholdSeconds: number
  foregroundApplications: boolean
  resources: boolean
  network: boolean
  watchDirectories: string[]
}

export interface BackgroundConfig {
  consolidateEveryTurns: number
  inputLimitTokens: number
  outputLimitTokens: number
  maxConcurrentJobs: number
  priority: 'low'
  retryLimit: number
}

export interface StorageConfig {
  directory: string
  transferDirectory: string
  syncIntervalSeconds: number
  backupDaily: boolean
  backupRetentionDays: number
  busyTimeoutMs: number
}

export interface CloudConfig {
  enabled: boolean
  syncOnStartup: boolean
  startupTimeoutSeconds: number
  autoUpload: boolean
  intervalSeconds: number
  credentialFile: string
}

export interface ObservabilityConfig {
  includeMessageContentByDefault: boolean
  retainProviderUsage: boolean
  retainStateRevisionAndReasonCodes: boolean
}

export interface ChannelConfig {
  /** dsh-onebot-qq 写出的 chat→session 映射；相对路径按 dsh home 解析。 */
  chatSessionsFile: string
  /** 允许启用陪伴行为的私聊 chatId（private:<qq>）。空数组 = 不启用任何会话。 */
  ownerChats: string[]
  /** 群聊扩展默认关闭：未显式启用的群不注入本人记忆与情感。 */
  enabledGroupChats: string[]
  /** NapCat / OneBot 11 HTTP 端点，仅在需要插件自己发送（主动消息）时使用。 */
  onebotHttpBase: string
  accessToken: string
}

export interface IntegrationConfig {
  naturalExpression: boolean
  enabled: boolean
  mode: 'augment' | 'standalone'
  localOwner: boolean
  excludedAgentIds: string[]
  contextBudgetTokens: number
  /** Stable role override; empty follows the host preset or persona text. */
  personaId: string
  personaPresets: Record<string, PresetId>
}

export interface Config {
  personality: PersonalityOptions
  expression: { mode: 'enforce' | 'diagnostic'; repairMaxCallsPerTurn: number; repairMaxCallsPerDay: number; historyTurns: number; auditRetentionDays: number }
  integration: IntegrationConfig
  companion: CompanionConfig
  generation: GenerationConfig
  memory: MemoryConfig
  affect: AffectConfig
  proactive: ProactiveConfig
  computerEvents: ComputerEventsConfig
  background: BackgroundConfig
  storage: StorageConfig
  cloud: CloudConfig
  observability: ObservabilityConfig
  channel: ChannelConfig
}

export function dshHome(): string {
  const env = process.env['DSH_HOME']
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

export const DEFAULT_CONFIG: Config = {
  personality: { mix: {}, overrides: {}, variation: { enabled: false, maxDelta: .05, seed: null } },
  expression: { mode: 'enforce', repairMaxCallsPerTurn: 1, repairMaxCallsPerDay: 10, historyTurns: 10, auditRetentionDays: 30 },
  integration: { enabled: true, naturalExpression: true, mode: 'augment', localOwner: true, excludedAgentIds: [], contextBudgetTokens: 450, personaId: '', personaPresets: {} },
  companion: {
    id: 'blue-fish-main',
    name: '蓝色大肥鱼',
    preset: 'balanced',
    scope: 'owner_private',
  },
  generation: {
    mode: 'companion',
    liveModelCalls: 1,
    thinking: 'disabled',
    protocolVersion: 1,
    sendOnSayClose: true,
    deliveryMode: 'bridge',
    metadataTargetTokens: 100,
    metadataHardLimitTokens: 192,
    plainTextFallback: true,
  },
  memory: {
    backend: 'sqlite',
    preserveRawText: true,
    inputHardLimitTokens: 4000,
    stateBudgetTokens: 150,
    retrievalAndCheckpointBudgetTokens: 350,
    candidateLimit: 50,
    selectedLimit: 6,
    retrievalDeadlineMs: 40,
    emotionBonusMax: 0.15,
    factualQueryEmotionBonus: 0,
    embeddingEnabled: false,
    migrationMode: 'backup_then_migrate',
  },
  affect: {
    ruleVersion: 'affect-v1',
    hostileConfidenceThreshold: 0.75,
    conflictEpisodeGapMinutes: 15,
    silenceChangesRelationship: false,
    allowNegativeRelationship: true,
    retortIntensity: 'moderate',
    halfLifeMinutes: {
      anger: 90,
      hurt: 360,
      joy: 120,
      tension: 60,
      expressiveness: 120,
    },
    dailyAbsoluteDeltaCaps: {
      affection: 0.12,
      trust: 0.15,
      respect: 0.2,
      grievance: 0.25,
    },
  },
  proactive: {
    adaptiveFrequency: true,
    adaptiveMaxDailyLimit: 4,
    adaptiveMinGapMinutes: 90,
    modelInterests: [],
    opportunityThreshold: .35,
    shareSources: [],
    enabled: true,
    timezone: 'Asia/Shanghai',
    quietStart: '23:00',
    quietEnd: '08:30',
    checkMinutes: 5,
    spontaneousLimitPerDay: 2,
    spontaneousMinGapMinutes: 180,
    pauseAfterUnanswered: 1,
    maxGenerationCallsPerCandidate: 1,
  },
  computerEvents: { enabled: false, pollSeconds: 30, idleThresholdSeconds: 1200, foregroundApplications: false, resources: true, network: true, watchDirectories: [] },
  background: {
    consolidateEveryTurns: 8,
    inputLimitTokens: 2000,
    outputLimitTokens: 200,
    maxConcurrentJobs: 1,
    priority: 'low',
    retryLimit: 2,
  },
  storage: {
    directory: join(dshHome(), 'companions'),
    transferDirectory: '',
    syncIntervalSeconds: 300,
    backupDaily: true,
    backupRetentionDays: 7,
    busyTimeoutMs: 1000,
  },
  cloud: { enabled: false, syncOnStartup: true, startupTimeoutSeconds: 15, autoUpload: true, intervalSeconds: 300, credentialFile: '' },
  observability: {
    includeMessageContentByDefault: false,
    retainProviderUsage: true,
    retainStateRevisionAndReasonCodes: true,
  },
  channel: {
    chatSessionsFile: join(dshHome(), 'media', 'onebot', 'chat-sessions.json'),
    ownerChats: [],
    enabledGroupChats: [],
    onebotHttpBase: 'http://127.0.0.1:3000',
    accessToken: '',
  },
}

export class ConfigError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ConfigError'
    this.field = field
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(field, '必须是对象')
  }
  return value as Record<string, unknown>
}

function readString(obj: Record<string, unknown>, key: string, field: string, fallback: string): string {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new ConfigError(`${field}.${key}`, '必须是字符串')
  return value
}

function readBool(obj: Record<string, unknown>, key: string, field: string, fallback: boolean): boolean {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(`${field}.${key}`, '必须是布尔值')
  return value
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  field: string,
  fallback: number,
  range?: { min?: number; max?: number },
): number {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${field}.${key}`, '必须是有限数字')
  }
  if (range?.min !== undefined && value < range.min) {
    throw new ConfigError(`${field}.${key}`, `不得小于 ${range.min}`)
  }
  if (range?.max !== undefined && value > range.max) {
    throw new ConfigError(`${field}.${key}`, `不得大于 ${range.max}`)
  }
  return value
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  field: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`${field}.${key}`, `必须是 ${allowed.join(' | ')} 之一`)
  }
  return value as T
}

function readStringArray(obj: Record<string, unknown>, key: string, field: string, fallback: string[]): string[] {
  const value = obj[key]
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`${field}.${key}`, '必须是字符串数组')
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** 相对路径按 dsh home 解析；同时防止落到字面占位目录名。 */
function resolvePath(raw: string, fallback: string, field: string): string {
  const value = raw !== '' ? raw : fallback
  if (value.includes('resolved_from_actual_dsh_data_root')) {
    throw new ConfigError(field, '仍是占位值 resolved_from_actual_dsh_data_root，必须解析成真实绝对路径')
  }
  const expanded = value.replace(/^~(?=$|[\\/])/, homedir())
  return isAbsolute(expanded) ? resolve(expanded) : resolve(dshHome(), expanded)
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * 把 patch 层传入的原始对象解析成完整配置。任何非法字段抛 ConfigError，
 * 调用方（apply）负责把它变成一条可读的加载失败日志。
 */
export function resolveConfig(raw: unknown = {}): Config {
  const root = asRecord(raw, 'config')
  const personality = asRecord(root['personality'], 'personality')
  const variation = asRecord(personality['variation'], 'personality.variation')
  const expression = asRecord(root['expression'], 'expression')
  const integration = asRecord(root['integration'], 'integration')
  const companion = asRecord(root['companion'], 'companion')
  const generation = asRecord(root['generation'], 'generation')
  const memory = asRecord(root['memory'], 'memory')
  const affect = asRecord(root['affect'], 'affect')
  const proactive = asRecord(root['proactive'], 'proactive')
  const computerEvents = asRecord(root['computerEvents'], 'computerEvents')
  const background = asRecord(root['background'], 'background')
  const storage = asRecord(root['storage'], 'storage')
  const cloud = asRecord(root['cloud'], 'cloud')
  const observability = asRecord(root['observability'], 'observability')
  const channel = asRecord(root['channel'], 'channel')

  // §16.1 顶层也允许扁平写法（patch 里常直接写 generation.mode 等），
  // 这里只接受分组写法，扁平误写会被下面的「未知字段」检查抓到。
  assertNoUnknown(root, ['personality', 'expression', 'integration', 'companion', 'generation', 'memory', 'affect', 'proactive', 'computerEvents', 'background', 'storage', 'cloud', 'observability', 'channel'], 'config')
  assertNoUnknown(computerEvents, ['enabled', 'pollSeconds', 'idleThresholdSeconds', 'foregroundApplications', 'resources', 'network', 'watchDirectories'], 'computerEvents')
  assertNoUnknown(cloud, ['enabled', 'syncOnStartup', 'startupTimeoutSeconds', 'autoUpload', 'intervalSeconds', 'credentialFile'], 'cloud')
  assertNoUnknown(personality, ['mix', 'overrides', 'variation'], 'personality')
  assertNoUnknown(variation, ['enabled', 'maxDelta', 'seed'], 'personality.variation')
  assertNoUnknown(expression, ['mode', 'repairMaxCallsPerTurn', 'repairMaxCallsPerDay', 'historyTurns', 'auditRetentionDays'], 'expression')
  const personalityOptions: PersonalityOptions = {
    mix: asRecord(personality['mix'], 'personality.mix') as Record<string, number>,
    overrides: asRecord(personality['overrides'], 'personality.overrides'),
    variation: { enabled: readBool(variation, 'enabled', 'personality.variation', false), maxDelta: readNumber(variation, 'maxDelta', 'personality.variation', .05, { min: 0, max: .05 }), seed: variation['seed'] === null || variation['seed'] === undefined ? null : readString(variation, 'seed', 'personality.variation', '') },
  }
  try { validatePersonality(personalityOptions) } catch (error) { throw new ConfigError('personality', String(error)) }

  const halfLife = asRecord(affect['halfLifeMinutes'], 'affect.halfLifeMinutes')
  const caps = asRecord(affect['dailyAbsoluteDeltaCaps'], 'affect.dailyAbsoluteDeltaCaps')

  const quietStart = readString(proactive, 'quietStart', 'proactive', DEFAULT_CONFIG.proactive.quietStart)
  const quietEnd = readString(proactive, 'quietEnd', 'proactive', DEFAULT_CONFIG.proactive.quietEnd)
  if (!TIME_RE.test(quietStart)) throw new ConfigError('proactive.quietStart', '必须是 HH:mm')
  if (!TIME_RE.test(quietEnd)) throw new ConfigError('proactive.quietEnd', '必须是 HH:mm')

  const config: Config = {
    personality: personalityOptions,
    expression: {
      mode: readEnum(expression, 'mode', 'expression', integration['naturalExpression'] === false ? 'diagnostic' : 'enforce', ['enforce', 'diagnostic'] as const),
      repairMaxCallsPerTurn: readNumber(expression, 'repairMaxCallsPerTurn', 'expression', 1, { min: 0, max: 1 }),
      repairMaxCallsPerDay: readNumber(expression, 'repairMaxCallsPerDay', 'expression', 10, { min: 0, max: 100 }),
      historyTurns: readNumber(expression, 'historyTurns', 'expression', 10, { min: 1, max: 50 }),
      auditRetentionDays: readNumber(expression, 'auditRetentionDays', 'expression', 30, { min: 1, max: 365 }),
    },
    integration: {
      naturalExpression: readBool(integration, 'naturalExpression', 'integration', true),
      enabled: readBool(integration, 'enabled', 'integration', true),
      mode: readEnum(integration, 'mode', 'integration', 'augment' as const, ['augment', 'standalone'] as const),
      localOwner: readBool(integration, 'localOwner', 'integration', true),
      excludedAgentIds: readStringArray(integration, 'excludedAgentIds', 'integration', []),
      contextBudgetTokens: readNumber(integration, 'contextBudgetTokens', 'integration', 450, { min: 100, max: 2000 }),
      personaId: readString(integration, 'personaId', 'integration', '').trim(),
      personaPresets: Object.fromEntries(Object.entries(asRecord(integration['personaPresets'], 'integration.personaPresets')).map(([id, value]) => [
        id, readEnum({ preset: value }, 'preset', `integration.personaPresets.${id}`, 'balanced' as const, ['irritable', 'balanced', 'gentle'] as const),
      ])),
    },
    companion: {
      id: readString(companion, 'id', 'companion', DEFAULT_CONFIG.companion.id),
      name: readString(companion, 'name', 'companion', DEFAULT_CONFIG.companion.name),
      preset: readEnum(companion, 'preset', 'companion', DEFAULT_CONFIG.companion.preset, [
        'irritable',
        'balanced',
        'gentle',
      ] as const),
      scope: readEnum(companion, 'scope', 'companion', DEFAULT_CONFIG.companion.scope, [
        'owner_private',
        'owner_all',
      ] as const),
    },
    generation: {
      mode: readEnum(generation, 'mode', 'generation', DEFAULT_CONFIG.generation.mode, ['companion', 'plain'] as const),
      liveModelCalls: readNumber(generation, 'liveModelCalls', 'generation', 1, { min: 1, max: 1 }),
      thinking: readEnum(generation, 'thinking', 'generation', DEFAULT_CONFIG.generation.thinking, [
        'disabled',
        'default',
      ] as const),
      protocolVersion: readNumber(generation, 'protocolVersion', 'generation', 1, { min: 1, max: 1 }),
      sendOnSayClose: readBool(generation, 'sendOnSayClose', 'generation', true),
      deliveryMode: readEnum(generation, 'deliveryMode', 'generation', DEFAULT_CONFIG.generation.deliveryMode, [
        'bridge',
        'early',
      ] as const),
      metadataTargetTokens: readNumber(generation, 'metadataTargetTokens', 'generation', 100, { min: 16 }),
      metadataHardLimitTokens: readNumber(generation, 'metadataHardLimitTokens', 'generation', 192, { min: 16 }),
      plainTextFallback: readBool(generation, 'plainTextFallback', 'generation', true),
    },
    memory: {
      backend: readEnum(memory, 'backend', 'memory', 'sqlite' as const, ['sqlite'] as const),
      preserveRawText: readBool(memory, 'preserveRawText', 'memory', true),
      inputHardLimitTokens: readNumber(memory, 'inputHardLimitTokens', 'memory', 4000, { min: 512 }),
      stateBudgetTokens: readNumber(memory, 'stateBudgetTokens', 'memory', 150, { min: 32 }),
      retrievalAndCheckpointBudgetTokens: readNumber(
        memory,
        'retrievalAndCheckpointBudgetTokens',
        'memory',
        350,
        { min: 32 },
      ),
      candidateLimit: readNumber(memory, 'candidateLimit', 'memory', 50, { min: 1 }),
      selectedLimit: readNumber(memory, 'selectedLimit', 'memory', 6, { min: 1 }),
      retrievalDeadlineMs: readNumber(memory, 'retrievalDeadlineMs', 'memory', 40, { min: 1 }),
      emotionBonusMax: readNumber(memory, 'emotionBonusMax', 'memory', 0.15, { min: 0, max: 1 }),
      factualQueryEmotionBonus: readNumber(memory, 'factualQueryEmotionBonus', 'memory', 0, { min: 0 }),
      embeddingEnabled: (() => {
        const embedding = asRecord(memory['embedding'], 'memory.embedding')
        return readBool(embedding, 'enabled', 'memory.embedding', false)
      })(),
      migrationMode: readEnum(memory, 'migrationMode', 'memory', 'backup_then_migrate' as const, [
        'backup_then_migrate',
        'migrate_only',
      ] as const),
    },
    affect: {
      ruleVersion: readString(affect, 'ruleVersion', 'affect', DEFAULT_CONFIG.affect.ruleVersion),
      hostileConfidenceThreshold: readNumber(
        affect,
        'hostileConfidenceThreshold',
        'affect',
        0.75,
        { min: 0, max: 1 },
      ),
      conflictEpisodeGapMinutes: readNumber(affect, 'conflictEpisodeGapMinutes', 'affect', 15, { min: 0 }),
      silenceChangesRelationship: readBool(affect, 'silenceChangesRelationship', 'affect', false),
      allowNegativeRelationship: readBool(affect, 'allowNegativeRelationship', 'affect', true),
      retortIntensity: readEnum(affect, 'retortIntensity', 'affect', 'moderate' as const, [
        'mild',
        'moderate',
        'strong',
      ] as const),
      halfLifeMinutes: {
        anger: readNumber(halfLife, 'anger', 'affect.halfLifeMinutes', 90, { min: 1 }),
        hurt: readNumber(halfLife, 'hurt', 'affect.halfLifeMinutes', 360, { min: 1 }),
        joy: readNumber(halfLife, 'joy', 'affect.halfLifeMinutes', 120, { min: 1 }),
        tension: readNumber(halfLife, 'tension', 'affect.halfLifeMinutes', 60, { min: 1 }),
        expressiveness: readNumber(halfLife, 'expressiveness', 'affect.halfLifeMinutes', 120, { min: 1 }),
      },
      dailyAbsoluteDeltaCaps: {
        affection: readNumber(caps, 'affection', 'affect.dailyAbsoluteDeltaCaps', 0.12, { min: 0 }),
        trust: readNumber(caps, 'trust', 'affect.dailyAbsoluteDeltaCaps', 0.15, { min: 0 }),
        respect: readNumber(caps, 'respect', 'affect.dailyAbsoluteDeltaCaps', 0.2, { min: 0 }),
        grievance: readNumber(caps, 'grievance', 'affect.dailyAbsoluteDeltaCaps', 0.25, { min: 0 }),
      },
    },
    proactive: {
      adaptiveFrequency: readBool(proactive, 'adaptiveFrequency', 'proactive', true),
      adaptiveMaxDailyLimit: readNumber(proactive, 'adaptiveMaxDailyLimit', 'proactive', 4, { min: 0, max: 24 }),
      adaptiveMinGapMinutes: readNumber(proactive, 'adaptiveMinGapMinutes', 'proactive', 90, { min: 10, max: 1440 }),
      modelInterests: readStringArray(proactive, 'modelInterests', 'proactive', []),
      opportunityThreshold: readNumber(proactive, 'opportunityThreshold', 'proactive', .35, { min: -1, max: 1 }),
      shareSources: readStringArray(proactive, 'shareSources', 'proactive', []),
      enabled: readBool(proactive, 'enabled', 'proactive', true),
      timezone: readString(proactive, 'timezone', 'proactive', DEFAULT_CONFIG.proactive.timezone),
      quietStart,
      quietEnd,
      checkMinutes: readNumber(proactive, 'checkMinutes', 'proactive', 5, { min: 1 }),
      spontaneousLimitPerDay: readNumber(proactive, 'spontaneousLimitPerDay', 'proactive', 2, { min: 0 }),
      spontaneousMinGapMinutes: readNumber(proactive, 'spontaneousMinGapMinutes', 'proactive', 180, { min: 0 }),
      pauseAfterUnanswered: readNumber(proactive, 'pauseAfterUnanswered', 'proactive', 1, { min: 0 }),
      maxGenerationCallsPerCandidate: readNumber(
        proactive,
        'maxGenerationCallsPerCandidate',
        'proactive',
        1,
        { min: 0, max: 1 },
      ),
    },
    computerEvents: {
      enabled: readBool(computerEvents, 'enabled', 'computerEvents', false),
      pollSeconds: readNumber(computerEvents, 'pollSeconds', 'computerEvents', 30, { min: 10, max: 3600 }),
      idleThresholdSeconds: readNumber(computerEvents, 'idleThresholdSeconds', 'computerEvents', 1200, { min: 60, max: 86400 }),
      foregroundApplications: readBool(computerEvents, 'foregroundApplications', 'computerEvents', false),
      resources: readBool(computerEvents, 'resources', 'computerEvents', true),
      network: readBool(computerEvents, 'network', 'computerEvents', true),
      watchDirectories: readStringArray(computerEvents, 'watchDirectories', 'computerEvents', []).map(path => resolvePath(path, path, 'computerEvents.watchDirectories')),
    },
    background: {
      consolidateEveryTurns: readNumber(background, 'consolidateEveryTurns', 'background', 8, { min: 1 }),
      inputLimitTokens: readNumber(background, 'inputLimitTokens', 'background', 2000, { min: 128 }),
      outputLimitTokens: readNumber(background, 'outputLimitTokens', 'background', 200, { min: 32 }),
      maxConcurrentJobs: readNumber(background, 'maxConcurrentJobs', 'background', 1, { min: 1 }),
      priority: 'low',
      retryLimit: readNumber(background, 'retryLimit', 'background', 2, { min: 0 }),
    },
    storage: {
      syncIntervalSeconds: readNumber(storage, 'syncIntervalSeconds', 'storage', 300, { min: 30, max: 86400 }),
      transferDirectory: (() => {
        const path = readString(storage, 'transferDirectory', 'storage', '')
        return path ? resolvePath(path, path, 'storage.transferDirectory') : ''
      })(),
      directory: resolvePath(
        readString(storage, 'directory', 'storage', ''),
        join(dshHome(), 'companions'),
        'storage.directory',
      ),
      backupDaily: readBool(storage, 'backupDaily', 'storage', true),
      backupRetentionDays: readNumber(storage, 'backupRetentionDays', 'storage', 7, { min: 1 }),
      busyTimeoutMs: readNumber(storage, 'busyTimeoutMs', 'storage', 1000, { min: 1 }),
    },
    cloud: {
      enabled: readBool(cloud, 'enabled', 'cloud', false),
      syncOnStartup: readBool(cloud, 'syncOnStartup', 'cloud', true),
        startupTimeoutSeconds: readNumber(cloud, 'startupTimeoutSeconds', 'cloud', 15, { min: 1, max: 120 }),
      autoUpload: readBool(cloud, 'autoUpload', 'cloud', true),
      intervalSeconds: readNumber(cloud, 'intervalSeconds', 'cloud', 300, { min: 30, max: 86400 }),
      credentialFile: (() => { const file = readString(cloud, 'credentialFile', 'cloud', ''); return file ? resolvePath(file, file, 'cloud.credentialFile') : '' })(),
    },
    observability: {
      includeMessageContentByDefault: readBool(observability, 'includeMessageContentByDefault', 'observability', false),
      retainProviderUsage: readBool(observability, 'retainProviderUsage', 'observability', true),
      retainStateRevisionAndReasonCodes: readBool(
        observability,
        'retainStateRevisionAndReasonCodes',
        'observability',
        true,
      ),
    },
    channel: {
      chatSessionsFile: resolvePath(
        readString(channel, 'chatSessionsFile', 'channel', ''),
        join(dshHome(), 'media', 'onebot', 'chat-sessions.json'),
        'channel.chatSessionsFile',
      ),
      ownerChats: readStringArray(channel, 'ownerChats', 'channel', []),
      enabledGroupChats: readStringArray(channel, 'enabledGroupChats', 'channel', []),
      onebotHttpBase: readString(channel, 'onebotHttpBase', 'channel', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      accessToken: readString(channel, 'accessToken', 'channel', ''),
    },
  }

  if (config.generation.metadataHardLimitTokens < config.generation.metadataTargetTokens) {
    throw new ConfigError('generation.metadataHardLimitTokens', '不得小于 metadataTargetTokens')
  }
  if (config.memory.selectedLimit > config.memory.candidateLimit) {
    throw new ConfigError('memory.selectedLimit', '不得大于 candidateLimit')
  }
  if (config.generation.deliveryMode === 'early' && !config.generation.sendOnSayClose) {
    throw new ConfigError('generation.deliveryMode', "deliveryMode=early 需要 sendOnSayClose=true")
  }
  try { new Intl.DateTimeFormat('en', { timeZone: config.proactive.timezone }).format(0) } catch { throw new ConfigError('proactive.timezone', '必须是有效的IANA时区') }
  if (config.proactive.shareSources.length > 4) throw new ConfigError('proactive.shareSources', '最多4个明确授权的来源')
  if (config.computerEvents.watchDirectories.length > 8) throw new ConfigError('computerEvents.watchDirectories', '最多8个指定目录')
  for (const [key, value] of Object.entries({ adaptiveMaxDailyLimit: config.proactive.adaptiveMaxDailyLimit, spontaneousLimitPerDay: config.proactive.spontaneousLimitPerDay, pauseAfterUnanswered: config.proactive.pauseAfterUnanswered })) if (!Number.isInteger(value)) throw new ConfigError(`proactive.${key}`, '必须是整数')
  if (config.proactive.modelInterests.length > 20 || config.proactive.modelInterests.some(value => value.length > 80)) throw new ConfigError('proactive.modelInterests', '最多20个兴趣，每项最多80字')
  for (const address of config.proactive.shareSources) {
    try { const url = new URL(address); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid') } catch { throw new ConfigError('proactive.shareSources', '必须是无凭据的HTTPS网址') }
  }
  for (const [field, value] of Object.entries({ repairMaxCallsPerTurn: config.expression.repairMaxCallsPerTurn, repairMaxCallsPerDay: config.expression.repairMaxCallsPerDay, historyTurns: config.expression.historyTurns, auditRetentionDays: config.expression.auditRetentionDays })) if (!Number.isInteger(value)) throw new ConfigError(`expression.${field}`, '必须是整数')
  if (config.expression.mode === 'enforce') {
    config.integration.naturalExpression = true
    config.integration.contextBudgetTokens = Math.max(config.integration.contextBudgetTokens, MIN_EXPRESSION_BUDGET)
  }

  config.channel.ownerChats = config.channel.ownerChats.map(id => id.startsWith('private:') ? id : `private:${id}`)
  config.channel.enabledGroupChats = config.channel.enabledGroupChats.map(id => id.startsWith('group:') ? id : `group:${id}`)
  return freeze(config) as Config
}

function assertNoUnknown(obj: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${field}.${key}`, `未知配置段（允许：${allowed.join(', ')}）`)
    }
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

/** 脱敏后的配置快照，用于 docs/ENVIRONMENT.md 与 doctor 输出。 */
export function redactConfig(config: Config): Record<string, Json> {
  return {
    integration: { ...config.integration },
    companion: { ...config.companion },
    generation: { ...config.generation },
    memory: { ...config.memory, embeddingEnabled: config.memory.embeddingEnabled },
    affect: {
      ruleVersion: config.affect.ruleVersion,
      hostileConfidenceThreshold: config.affect.hostileConfidenceThreshold,
      conflictEpisodeGapMinutes: config.affect.conflictEpisodeGapMinutes,
      retortIntensity: config.affect.retortIntensity,
    },
    proactive: { ...config.proactive },
    computerEvents: { ...config.computerEvents },
    background: { ...config.background },
    storage: { ...config.storage },
    cloud: { ...config.cloud },
    observability: { ...config.observability },
    channel: {
      chatSessionsFile: config.channel.chatSessionsFile,
      ownerChats: config.channel.ownerChats.map(maskId),
      enabledGroupChats: config.channel.enabledGroupChats.map(maskId),
      onebotHttpBase: config.channel.onebotHttpBase,
      accessToken: config.channel.accessToken === '' ? '' : '***',
    },
  } as Record<string, Json>
}

export function maskId(id: string): string {
  if (id.length <= 4) return '***'
  return `${id.slice(0, 2)}***${id.slice(-2)}`
}
