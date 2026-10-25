export function companionInterests(repos, config, principalId) {
    try {
        const saved = JSON.parse(repos.getSetting(`proactive.model-interests:${principalId}`) ?? 'null');
        if (Array.isArray(saved) && saved.every(value => typeof value === 'string'))
            return saved;
    }
    catch { /* Invalid imported settings fall back to configured interests. */ }
    return config.proactive.modelInterests;
}
//# sourceMappingURL=interests.js.map