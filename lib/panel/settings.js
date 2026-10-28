import { resolveConfig } from '../config.js';
const SETTINGS_KEY = 'local.control-panel.settings';
const proactiveKeys = ['adaptiveFrequency', 'adaptiveMaxDailyLimit', 'adaptiveMinGapMinutes', 'modelInterests', 'opportunityThreshold', 'shareSources', 'timezone', 'quietStart', 'quietEnd', 'checkMinutes', 'spontaneousLimitPerDay', 'spontaneousMinGapMinutes', 'pauseAfterUnanswered'];
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('设置格式无效。');
    return value;
}
export function updatePanelSettings(repos, config, input, persist = true, principalId) {
    const body = record(input);
    if (Object.keys(body).some(key => !['proactive', 'computerEvents', 'emotion', 'perception'].includes(key)))
        throw Error('未知设置项。');
    const proactive = body['proactive'] === undefined ? {} : record(body['proactive']);
    if (Object.keys(proactive).some(key => !proactiveKeys.includes(key)))
        throw Error('未知主动联系设置。');
    const computerEvents = body['computerEvents'] === undefined ? {} : record(body['computerEvents']);
    const candidate = resolveConfig({ ...config, proactive: { ...config.proactive, ...proactive }, computerEvents: { ...config.computerEvents, ...computerEvents }, emotion: { ...config.emotion, ...record(body['emotion'] ?? {}) }, perception: { ...config.perception, ...record(body['perception'] ?? {}) } });
    const defaultInterests = config.proactive.modelInterests;
    if (principalId && proactive['modelInterests'] !== undefined)
        repos.setSetting(`proactive.model-interests:${principalId}`, JSON.stringify(candidate.proactive.modelInterests), Date.now());
    config.proactive = { ...structuredClone(candidate.proactive), ...(principalId ? { modelInterests: defaultInterests } : {}) };
    config.computerEvents = structuredClone(candidate.computerEvents);
    config.emotion = structuredClone(candidate.emotion);
    config.perception = structuredClone(candidate.perception);
    if (persist) {
        repos.setSetting('emotion.parameters', JSON.stringify(config.emotion), Date.now());
        repos.setSetting(SETTINGS_KEY, JSON.stringify({ proactive: Object.fromEntries(proactiveKeys.map(key => [key, config.proactive[key]])), computerEvents: config.computerEvents, perception: config.perception }), Date.now());
    }
}
export function loadPanelSettings(repos, config) {
    const saved = repos.getSetting(SETTINGS_KEY);
    if (saved) {
        try {
            updatePanelSettings(repos, config, JSON.parse(saved), false);
        }
        catch { /* A bad local setting must not prevent startup. */ }
    }
    const emotion = repos.getSetting('emotion.parameters');
    if (emotion) {
        try {
            config.emotion = resolveConfig({ ...config, emotion: JSON.parse(emotion) }).emotion;
        }
        catch { /* Keep validated deployment defaults. */ }
    }
}
//# sourceMappingURL=settings.js.map