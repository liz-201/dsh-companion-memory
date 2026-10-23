/**
 * 配置解析（任务书 §16.1）。
 *
 * 不引入 schemastery 等外部依赖：宿主 patch 层把 config 作为普通对象传进来，
 * 这里给出**可读的字段级错误**，绝不静默回落到不安全的空值。
 */
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
export function dshHome() {
    const env = process.env['DSH_HOME'];
    return env !== undefined && env !== '' ? env : join(homedir(), '.dsh');
}
export const DEFAULT_CONFIG = {
    integration: { enabled: true, mode: 'augment', localOwner: true, excludedAgentIds: [], contextBudgetTokens: 450 },
    companion: {
        id: 'blue-fish-main',
        name: '蓝色大肥鱼',
        preset: 'irritable',
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
    background: {
        consolidateEveryTurns: 25,
        inputLimitTokens: 2000,
        outputLimitTokens: 200,
        maxConcurrentJobs: 1,
        priority: 'low',
        retryLimit: 2,
    },
    storage: {
        directory: join(dshHome(), 'companions'),
        backupDaily: true,
        backupRetentionDays: 7,
        busyTimeoutMs: 1000,
    },
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
};
export class ConfigError extends Error {
    field;
    constructor(field, message) {
        super(`${field}: ${message}`);
        this.name = 'ConfigError';
        this.field = field;
    }
}
function asRecord(value, field) {
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigError(field, '必须是对象');
    }
    return value;
}
function readString(obj, key, field, fallback) {
    const value = obj[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== 'string')
        throw new ConfigError(`${field}.${key}`, '必须是字符串');
    return value;
}
function readBool(obj, key, field, fallback) {
    const value = obj[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        throw new ConfigError(`${field}.${key}`, '必须是布尔值');
    return value;
}
function readNumber(obj, key, field, fallback, range) {
    const value = obj[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigError(`${field}.${key}`, '必须是有限数字');
    }
    if (range?.min !== undefined && value < range.min) {
        throw new ConfigError(`${field}.${key}`, `不得小于 ${range.min}`);
    }
    if (range?.max !== undefined && value > range.max) {
        throw new ConfigError(`${field}.${key}`, `不得大于 ${range.max}`);
    }
    return value;
}
function readEnum(obj, key, field, fallback, allowed) {
    const value = obj[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new ConfigError(`${field}.${key}`, `必须是 ${allowed.join(' | ')} 之一`);
    }
    return value;
}
function readStringArray(obj, key, field, fallback) {
    const value = obj[key];
    if (value === undefined)
        return [...fallback];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new ConfigError(`${field}.${key}`, '必须是字符串数组');
    }
    return value.map((entry) => entry.trim()).filter((entry) => entry !== '');
}
/** 相对路径按 dsh home 解析；同时防止落到字面占位目录名。 */
function resolvePath(raw, fallback, field) {
    const value = raw !== '' ? raw : fallback;
    if (value.includes('resolved_from_actual_dsh_data_root')) {
        throw new ConfigError(field, '仍是占位值 resolved_from_actual_dsh_data_root，必须解析成真实绝对路径');
    }
    const expanded = value.replace(/^~(?=$|[\\/])/, homedir());
    return isAbsolute(expanded) ? resolve(expanded) : resolve(dshHome(), expanded);
}
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/**
 * 把 patch 层传入的原始对象解析成完整配置。任何非法字段抛 ConfigError，
 * 调用方（apply）负责把它变成一条可读的加载失败日志。
 */
export function resolveConfig(raw = {}) {
    const root = asRecord(raw, 'config');
    const integration = asRecord(root['integration'], 'integration');
    const companion = asRecord(root['companion'], 'companion');
    const generation = asRecord(root['generation'], 'generation');
    const memory = asRecord(root['memory'], 'memory');
    const affect = asRecord(root['affect'], 'affect');
    const proactive = asRecord(root['proactive'], 'proactive');
    const background = asRecord(root['background'], 'background');
    const storage = asRecord(root['storage'], 'storage');
    const observability = asRecord(root['observability'], 'observability');
    const channel = asRecord(root['channel'], 'channel');
    // §16.1 顶层也允许扁平写法（patch 里常直接写 generation.mode 等），
    // 这里只接受分组写法，扁平误写会被下面的「未知字段」检查抓到。
    assertNoUnknown(root, ['integration', 'companion', 'generation', 'memory', 'affect', 'proactive', 'background', 'storage', 'observability', 'channel'], 'config');
    const halfLife = asRecord(affect['halfLifeMinutes'], 'affect.halfLifeMinutes');
    const caps = asRecord(affect['dailyAbsoluteDeltaCaps'], 'affect.dailyAbsoluteDeltaCaps');
    const quietStart = readString(proactive, 'quietStart', 'proactive', DEFAULT_CONFIG.proactive.quietStart);
    const quietEnd = readString(proactive, 'quietEnd', 'proactive', DEFAULT_CONFIG.proactive.quietEnd);
    if (!TIME_RE.test(quietStart))
        throw new ConfigError('proactive.quietStart', '必须是 HH:mm');
    if (!TIME_RE.test(quietEnd))
        throw new ConfigError('proactive.quietEnd', '必须是 HH:mm');
    const config = {
        integration: {
            enabled: readBool(integration, 'enabled', 'integration', true),
            mode: readEnum(integration, 'mode', 'integration', 'augment', ['augment', 'standalone']),
            localOwner: readBool(integration, 'localOwner', 'integration', true),
            excludedAgentIds: readStringArray(integration, 'excludedAgentIds', 'integration', []),
            contextBudgetTokens: readNumber(integration, 'contextBudgetTokens', 'integration', 450, { min: 100, max: 2000 }),
        },
        companion: {
            id: readString(companion, 'id', 'companion', DEFAULT_CONFIG.companion.id),
            name: readString(companion, 'name', 'companion', DEFAULT_CONFIG.companion.name),
            preset: readEnum(companion, 'preset', 'companion', DEFAULT_CONFIG.companion.preset, [
                'irritable',
                'balanced',
                'gentle',
            ]),
            scope: readEnum(companion, 'scope', 'companion', DEFAULT_CONFIG.companion.scope, [
                'owner_private',
                'owner_all',
            ]),
        },
        generation: {
            mode: readEnum(generation, 'mode', 'generation', DEFAULT_CONFIG.generation.mode, ['companion', 'plain']),
            liveModelCalls: readNumber(generation, 'liveModelCalls', 'generation', 1, { min: 1, max: 1 }),
            thinking: readEnum(generation, 'thinking', 'generation', DEFAULT_CONFIG.generation.thinking, [
                'disabled',
                'default',
            ]),
            protocolVersion: readNumber(generation, 'protocolVersion', 'generation', 1, { min: 1, max: 1 }),
            sendOnSayClose: readBool(generation, 'sendOnSayClose', 'generation', true),
            deliveryMode: readEnum(generation, 'deliveryMode', 'generation', DEFAULT_CONFIG.generation.deliveryMode, [
                'bridge',
                'early',
            ]),
            metadataTargetTokens: readNumber(generation, 'metadataTargetTokens', 'generation', 100, { min: 16 }),
            metadataHardLimitTokens: readNumber(generation, 'metadataHardLimitTokens', 'generation', 192, { min: 16 }),
            plainTextFallback: readBool(generation, 'plainTextFallback', 'generation', true),
        },
        memory: {
            backend: readEnum(memory, 'backend', 'memory', 'sqlite', ['sqlite']),
            preserveRawText: readBool(memory, 'preserveRawText', 'memory', true),
            inputHardLimitTokens: readNumber(memory, 'inputHardLimitTokens', 'memory', 4000, { min: 512 }),
            stateBudgetTokens: readNumber(memory, 'stateBudgetTokens', 'memory', 150, { min: 32 }),
            retrievalAndCheckpointBudgetTokens: readNumber(memory, 'retrievalAndCheckpointBudgetTokens', 'memory', 350, { min: 32 }),
            candidateLimit: readNumber(memory, 'candidateLimit', 'memory', 50, { min: 1 }),
            selectedLimit: readNumber(memory, 'selectedLimit', 'memory', 6, { min: 1 }),
            retrievalDeadlineMs: readNumber(memory, 'retrievalDeadlineMs', 'memory', 40, { min: 1 }),
            emotionBonusMax: readNumber(memory, 'emotionBonusMax', 'memory', 0.15, { min: 0, max: 1 }),
            factualQueryEmotionBonus: readNumber(memory, 'factualQueryEmotionBonus', 'memory', 0, { min: 0 }),
            embeddingEnabled: (() => {
                const embedding = asRecord(memory['embedding'], 'memory.embedding');
                return readBool(embedding, 'enabled', 'memory.embedding', false);
            })(),
            migrationMode: readEnum(memory, 'migrationMode', 'memory', 'backup_then_migrate', [
                'backup_then_migrate',
                'migrate_only',
            ]),
        },
        affect: {
            ruleVersion: readString(affect, 'ruleVersion', 'affect', DEFAULT_CONFIG.affect.ruleVersion),
            hostileConfidenceThreshold: readNumber(affect, 'hostileConfidenceThreshold', 'affect', 0.75, { min: 0, max: 1 }),
            conflictEpisodeGapMinutes: readNumber(affect, 'conflictEpisodeGapMinutes', 'affect', 15, { min: 0 }),
            silenceChangesRelationship: readBool(affect, 'silenceChangesRelationship', 'affect', false),
            allowNegativeRelationship: readBool(affect, 'allowNegativeRelationship', 'affect', true),
            retortIntensity: readEnum(affect, 'retortIntensity', 'affect', 'moderate', [
                'mild',
                'moderate',
                'strong',
            ]),
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
            enabled: readBool(proactive, 'enabled', 'proactive', true),
            timezone: readString(proactive, 'timezone', 'proactive', DEFAULT_CONFIG.proactive.timezone),
            quietStart,
            quietEnd,
            checkMinutes: readNumber(proactive, 'checkMinutes', 'proactive', 5, { min: 1 }),
            spontaneousLimitPerDay: readNumber(proactive, 'spontaneousLimitPerDay', 'proactive', 2, { min: 0 }),
            spontaneousMinGapMinutes: readNumber(proactive, 'spontaneousMinGapMinutes', 'proactive', 180, { min: 0 }),
            pauseAfterUnanswered: readNumber(proactive, 'pauseAfterUnanswered', 'proactive', 1, { min: 0 }),
            maxGenerationCallsPerCandidate: readNumber(proactive, 'maxGenerationCallsPerCandidate', 'proactive', 1, { min: 0, max: 1 }),
        },
        background: {
            consolidateEveryTurns: readNumber(background, 'consolidateEveryTurns', 'background', 25, { min: 1 }),
            inputLimitTokens: readNumber(background, 'inputLimitTokens', 'background', 2000, { min: 128 }),
            outputLimitTokens: readNumber(background, 'outputLimitTokens', 'background', 200, { min: 32 }),
            maxConcurrentJobs: readNumber(background, 'maxConcurrentJobs', 'background', 1, { min: 1 }),
            priority: 'low',
            retryLimit: readNumber(background, 'retryLimit', 'background', 2, { min: 0 }),
        },
        storage: {
            directory: resolvePath(readString(storage, 'directory', 'storage', ''), join(dshHome(), 'companions'), 'storage.directory'),
            backupDaily: readBool(storage, 'backupDaily', 'storage', true),
            backupRetentionDays: readNumber(storage, 'backupRetentionDays', 'storage', 7, { min: 1 }),
            busyTimeoutMs: readNumber(storage, 'busyTimeoutMs', 'storage', 1000, { min: 1 }),
        },
        observability: {
            includeMessageContentByDefault: readBool(observability, 'includeMessageContentByDefault', 'observability', false),
            retainProviderUsage: readBool(observability, 'retainProviderUsage', 'observability', true),
            retainStateRevisionAndReasonCodes: readBool(observability, 'retainStateRevisionAndReasonCodes', 'observability', true),
        },
        channel: {
            chatSessionsFile: resolvePath(readString(channel, 'chatSessionsFile', 'channel', ''), join(dshHome(), 'media', 'onebot', 'chat-sessions.json'), 'channel.chatSessionsFile'),
            ownerChats: readStringArray(channel, 'ownerChats', 'channel', []),
            enabledGroupChats: readStringArray(channel, 'enabledGroupChats', 'channel', []),
            onebotHttpBase: readString(channel, 'onebotHttpBase', 'channel', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
            accessToken: readString(channel, 'accessToken', 'channel', ''),
        },
    };
    if (config.generation.metadataHardLimitTokens < config.generation.metadataTargetTokens) {
        throw new ConfigError('generation.metadataHardLimitTokens', '不得小于 metadataTargetTokens');
    }
    if (config.memory.selectedLimit > config.memory.candidateLimit) {
        throw new ConfigError('memory.selectedLimit', '不得大于 candidateLimit');
    }
    if (config.generation.deliveryMode === 'early' && !config.generation.sendOnSayClose) {
        throw new ConfigError('generation.deliveryMode', "deliveryMode=early 需要 sendOnSayClose=true");
    }
    config.channel.ownerChats = config.channel.ownerChats.map(id => id.startsWith('private:') ? id : `private:${id}`);
    config.channel.enabledGroupChats = config.channel.enabledGroupChats.map(id => id.startsWith('group:') ? id : `group:${id}`);
    return freeze(config);
}
function assertNoUnknown(obj, allowed, field) {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
            throw new ConfigError(`${field}.${key}`, `未知配置段（允许：${allowed.join(', ')}）`);
        }
    }
}
function freeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const entry of Object.values(value))
            freeze(entry);
        Object.freeze(value);
    }
    return value;
}
/** 脱敏后的配置快照，用于 docs/ENVIRONMENT.md 与 doctor 输出。 */
export function redactConfig(config) {
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
        background: { ...config.background },
        storage: { ...config.storage },
        observability: { ...config.observability },
        channel: {
            chatSessionsFile: config.channel.chatSessionsFile,
            ownerChats: config.channel.ownerChats.map(maskId),
            enabledGroupChats: config.channel.enabledGroupChats.map(maskId),
            onebotHttpBase: config.channel.onebotHttpBase,
            accessToken: config.channel.accessToken === '' ? '' : '***',
        },
    };
}
export function maskId(id) {
    if (id.length <= 4)
        return '***';
    return `${id.slice(0, 2)}***${id.slice(-2)}`;
}
//# sourceMappingURL=config.js.map