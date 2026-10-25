import { activeHabits } from './habit-learning.js';
export function interactionHabits(repos, binding, nowMs) {
    return repos.activeMemories(binding.principalId, ['interaction_rule'], 12).filter(row => row.visibility === binding.visibility && (binding.visibility !== 'group' || row.conversation_id === binding.conversationId)
        && (row.valid_from_ms === null || row.valid_from_ms <= nowMs) && (row.valid_to_ms === null || row.valid_to_ms > nowMs)).slice(0, 2);
}
export function renderInteractionHabits(repos, binding, nowMs) {
    const habits = interactionHabits(repos, binding, nowMs);
    const recent = repos.db.all("SELECT content FROM raw_messages WHERE conversation_id = ? AND role = 'assistant' AND deleted_at_ms IS NULL ORDER BY seq DESC LIMIT 10", binding.conversationId).map(row => row.content);
    const learned = activeHabits(repos, binding, nowMs).filter(habit => habit.kind !== 'meme' || !recent.some(text => text.includes(habit.value))).map(habit => habit.kind === 'address_block' ? `不使用称呼：${habit.value}` : habit.kind === 'meme' ? `明确认可的共同梗（非必用，严肃时不使用）：${habit.value}` : habit.value);
    const values = [...learned, ...habits.map(row => row.claim.slice(0, 60))].slice(0, 4);
    return values.length ? `交流偏好资料（当前要求优先，勿照念）：${JSON.stringify(values)}` : '';
}
//# sourceMappingURL=interaction-habits.js.map