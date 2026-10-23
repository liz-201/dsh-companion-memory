/**
 * 身份绑定与作用域（任务书 §4 IdentityBinding、§13.1 人格作用域、§16.1 scope）。
 *
 * 原则：principal（用户）与会话各自独立；private 会话的可见性为 private，
 * 群聊为 group。未显式启用的会话不进入陪伴路径，也不写任何记忆。
 */
/** 同一伴随角色 + 同一机器人 + 同一用户 = 同一 principal。 */
export function principalKey(companionId, botAccountId, userId) {
    return `${companionId}:${botAccountId}:${userId}`;
}
export function conversationKey(principalId, kind, platformConversationId) {
    return `${principalId}:${kind}:${platformConversationId}`;
}
export function visibilityFor(kind) {
    return kind === 'private' ? 'private' : 'group';
}
export function resolveBinding(input) {
    const principalId = principalKey(input.companionId, input.botAccountId, input.userId);
    return {
        companionId: input.companionId,
        botAccountId: input.botAccountId,
        userId: input.userId,
        conversationId: input.conversationId,
        conversationKind: input.conversationKind,
        principalId,
        visibility: visibilityFor(input.conversationKind),
    };
}
/** 形如 `private:123456` / `group:987654`；与 dsh-onebot-qq 的 chatId 同构。 */
export function parseChatId(chatId) {
    const match = /^(private|group):(.+)$/.exec(chatId.trim());
    if (match === null)
        return null;
    const kind = match[1] === 'group' ? 'group' : 'private';
    const id = match[2].trim();
    if (id === '')
        return null;
    return { kind, id };
}
export function formatChatId(kind, id) {
    return `${kind}:${id}`;
}
/**
 * 陪伴行为只在显式启用的会话里生效。scope=owner_private 时群聊一律不进入，
 * 即使 group 出现在 enabledGroupChats 里——两个开关都要打开。
 */
export function decideActivation(companion, channel, chatId) {
    const parsed = parseChatId(chatId);
    if (parsed === null)
        return { active: false, reason: 'invalid_chat_id' };
    const normalized = formatChatId(parsed.kind, parsed.id);
    if (parsed.kind === 'private') {
        if (!channel.ownerChats.includes(normalized))
            return { active: false, reason: 'not_owner_chat' };
        return { active: true, reason: 'owner_private' };
    }
    if (companion.scope !== 'owner_all')
        return { active: false, reason: 'scope_mismatch' };
    if (!channel.enabledGroupChats.includes(normalized))
        return { active: false, reason: 'group_not_enabled' };
    return { active: true, reason: 'owner_all' };
}
/**
 * 记忆可见性过滤：private 记忆只在该 principal 的私聊可见；group 记忆可在
 * 同 principal 的群里复用但不得出现在别人的会话；shared 仅限同一 companion。
 */
export function canReadMemory(memoryVisibility, binding, memoryPrincipalId, memoryCompanionId) {
    if (memoryPrincipalId !== binding.principalId)
        return false;
    if (memoryVisibility === 'shared')
        return memoryCompanionId === binding.companionId;
    if (memoryVisibility === 'private')
        return binding.conversationKind === 'private';
    return binding.conversationKind === 'group';
}
//# sourceMappingURL=identity.js.map