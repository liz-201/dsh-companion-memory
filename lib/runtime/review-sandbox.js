import { initialSnapshot } from '../domain/affect-reducer.js';
export class ReviewSandbox {
    repos;
    config;
    constructor(repos, config) {
        this.repos = repos;
        this.config = config;
    }
    binding(real) {
        const raw = this.repos.getSetting(`review:${real.conversationId}`);
        return raw ? JSON.parse(raw) : null;
    }
    begin(real, fixture, nowMs) {
        if (!['friendly', 'tense', 'after_conflict'].includes(fixture))
            throw new Error('可选场景：friendly、tense、after_conflict');
        if (this.binding(real))
            throw new Error('已经处于 review，请先 /fish review end');
        const binding = {
            ...real, principalId: `review:${real.principalId}:${nowMs}`, conversationId: `review:${real.conversationId}:${nowMs}`,
        };
        this.repos.db.transaction(() => {
            this.repos.ensurePrincipal(binding.principalId, real.companionId, `review:${real.botAccountId}`, `${real.userId}:${nowMs}`, nowMs);
            this.repos.ensureConversation(binding.conversationId, binding.principalId, real.conversationKind, `review:${real.conversationId}`, nowMs);
            const snapshot = initialSnapshot(binding.principalId, this.config.companion.preset, this.config.affect.ruleVersion, nowMs);
            snapshot.relationship = fixture === 'friendly'
                ? { affection: 0.75, trust: 0.8, respect: 0.7, familiarity: 0.8, grievance: 0 }
                : { affection: fixture === 'tense' ? -0.15 : 0.5, trust: 0.35, respect: 0.45, familiarity: 0.6, grievance: 0.35 };
            if (fixture !== 'friendly')
                snapshot.mood = { ...snapshot.mood, anger: 0.45, hurt: 0.3 };
            this.repos.putSnapshot(snapshot, 0);
            this.repos.setSetting(`affect.baseline:${binding.principalId}`, JSON.stringify(snapshot), nowMs);
            this.repos.setSetting(`review:${real.conversationId}`, JSON.stringify(binding), nowMs);
            this.repos.audit({ principalId: binding.principalId, kind: 'review.fixture', entityId: fixture, payload: { fixture, realConversationId: real.conversationId }, createdAtMs: nowMs });
        });
        return `已进入 ${fixture} 测试场景。测试记忆与正式关系隔离，提醒和自发消息停用；/fish review end 退出。`;
    }
    end(real) {
        this.repos.db.run('DELETE FROM plugin_settings WHERE key = ?', `review:${real.conversationId}`);
        return '已退出 review，恢复正式关系和记忆。';
    }
}
//# sourceMappingURL=review-sandbox.js.map