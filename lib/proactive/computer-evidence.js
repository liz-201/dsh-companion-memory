export function computerEvidence(repos, id, principalId, conversationId, nowMs) {
    if (!id.startsWith('computer:'))
        return null;
    try {
        const evidence = JSON.parse(repos.getSetting(`local.computer-evidence:${id}`) ?? 'null');
        return evidence && evidence.id === id && evidence.principalId === principalId && evidence.conversationId === conversationId && evidence.expiresAtMs > nowMs ? evidence : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=computer-evidence.js.map