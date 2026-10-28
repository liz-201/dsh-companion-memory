import { createHash } from 'node:crypto';
import { humanSourceSql, isHumanMessage } from './source-policy.js';
export function learnExplicitHabit(repos, binding, message) {
    const text = message.content;
    if (!isHumanMessage(message) || /比如|假如|例如|台词|引用|[“「『]/.test(text) || /这次|这一条|这条回复/.test(text))
        return;
    let kind = '', value = '';
    const address = text.match(/(?:以后)?(?:别|不要)(?:再)?(?:叫|称呼)我([^，。！？\n]{1,12})/);
    const meme = text.match(/^以后(?:我们)?(?:可以|就|偶尔)?用(?:这个)?梗[：:]\s*(.{1,40})$/);
    if (address) {
        kind = 'address_block';
        value = address[1].trim();
    }
    else if (meme) {
        kind = 'meme';
        value = meme[1].trim();
    }
    else if (/以后.{0,8}(?:少用|不用|不要).{0,4}(?:表情|emoji)/i.test(text)) {
        kind = 'emoji';
        value = '少用表情';
    }
    else if (/以后.{0,8}(?:简短|短一点|少分点|不要分点)/.test(text)) {
        kind = 'verbosity';
        value = '闲聊简短，少分点；明确任务格式优先';
    }
    else if (/^(?:以后)?(?:你)?(?:说话|回答|回复)?(?:简短点|简短一点|短一点|别分点|不要分点|说人话|太长了|太啰嗦了|别写小作文)[吧啊呀，。！!\s]*$/.test(text)
        || /(?:你(?:说话|回答|回复).{0,8}(?:太长|啰嗦|小作文)|谁家.{0,8}正常说话.{0,8}小作文)/.test(text)) {
        kind = 'verbosity';
        value = '闲聊简短，少分点；明确任务格式优先';
    }
    else if (/以后.{0,8}(?:详细一点|详细些|多说一点)/.test(text)) {
        kind = 'verbosity';
        value = '说明可以详细些；当前任务要求优先';
    }
    else if (/(?:以后)?(?:别|不要).{0,6}(?:再发这种|再分享这种|发这个话题)/.test(text)) {
        kind = 'proactive_topic';
        value = text.slice(0, 120);
    }
    if (!kind) {
        proposeImplicitVerbosity(repos, binding, message.observedAtMs);
        return;
    }
    const key = createHash('sha256').update(`${binding.principalId}:${kind}:${message.id}`).digest('hex');
    if (repos.db.get('SELECT id FROM expression_habits WHERE id = ?', key))
        return;
    repos.db.transaction(() => {
        if (!['address_block', 'meme'].includes(kind))
            repos.db.run("UPDATE expression_habits SET status = 'revoked' WHERE principal_id = ? AND kind = ? AND status = 'active'", binding.principalId, kind);
        repos.db.run("INSERT INTO expression_habits VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL, ?, NULL)", key, binding.principalId, kind, JSON.stringify(value), JSON.stringify({ visibility: binding.visibility, conversationId: binding.visibility === 'group' ? binding.conversationId : null }), JSON.stringify([message.id]), key, message.observedAtMs);
    });
}
function proposeImplicitVerbosity(repos, binding, nowMs) {
    const rows = repos.db.all(`SELECT id, content, observed_at_ms FROM raw_messages WHERE conversation_id = ? AND ${humanSourceSql()} ORDER BY seq DESC LIMIT 3`, binding.conversationId);
    if (rows.length < 3 || rows.some(row => row.content.length >= 40 || /例如|比如|台词|[“「]/.test(row.content)))
        return;
    const id = `implicit-verbosity:${binding.principalId}:${binding.conversationId}`;
    repos.db.run("INSERT OR IGNORE INTO expression_habits VALUES (?, ?, 'implicit_verbosity', ?, ?, 'proposed', .4, ?, ?, NULL, ?, NULL)", id, binding.principalId, JSON.stringify('用户消息往往简短；只作待确认候选，不代表要求助手短答'), JSON.stringify({ visibility: binding.visibility, conversationId: binding.visibility === 'group' ? binding.conversationId : null }), JSON.stringify(rows.slice(0, 3).map(row => row.id)), id, nowMs);
}
export function activeHabits(repos, binding, nowMs) {
    return repos.db.all("SELECT * FROM expression_habits WHERE principal_id = ? AND status = 'active' AND valid_from_ms <= ? AND (valid_until_ms IS NULL OR valid_until_ms > ?) ORDER BY valid_from_ms DESC LIMIT 20", binding.principalId, nowMs, nowMs).filter(row => {
        const scope = JSON.parse(String(row['scope_json']));
        if (scope.visibility !== binding.visibility || scope.conversationId && scope.conversationId !== binding.conversationId)
            return false;
        const sources = JSON.parse(String(row['source_ids_json']));
        return sources.length > 0 && sources.every(id => { const raw = repos.getRawMessage(id); return raw && isHumanMessage(raw) && repos.db.get('SELECT principal_id FROM conversations WHERE id = ?', raw.conversationId)?.principal_id === binding.principalId; });
    }).map(row => ({ id: String(row['id']), kind: String(row['kind']), value: JSON.parse(String(row['value_json'])), sources: JSON.parse(String(row['source_ids_json'])), status: String(row['status']) }));
}
export function revokeDerivedSources(repos, deletedIds) {
    const deleted = new Set(deletedIds);
    for (const table of ['expression_habits', 'episodic_annotations', 'proactive_opportunities'])
        for (const row of repos.db.all(`SELECT id, source_ids_json FROM ${table}`)) {
            if (!JSON.parse(row.source_ids_json).some(id => deleted.has(id)))
                continue;
            if (table === 'expression_habits')
                repos.db.run("UPDATE expression_habits SET status = 'revoked' WHERE id = ?", row.id);
            else if (table === 'proactive_opportunities') {
                repos.db.run("UPDATE proactive_opportunities SET status = 'cancelled' WHERE id = ?", row.id);
                repos.db.run("UPDATE outbox SET status = 'cancelled' WHERE opportunity_id = ? AND status = 'pending'", row.id);
            }
            else
                repos.db.run('DELETE FROM episodic_annotations WHERE id = ?', row.id);
        }
}
//# sourceMappingURL=habit-learning.js.map