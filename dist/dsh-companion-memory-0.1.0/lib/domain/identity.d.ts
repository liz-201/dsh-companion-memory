/**
 * 身份绑定与作用域（任务书 §4 IdentityBinding、§13.1 人格作用域、§16.1 scope）。
 *
 * 原则：principal（用户）与会话各自独立；private 会话的可见性为 private，
 * 群聊为 group。未显式启用的会话不进入陪伴路径，也不写任何记忆。
 */
import type { ChannelConfig, CompanionConfig } from '../config.js';
import type { IdentityBinding, Visibility } from './types.js';
export interface BindingInput {
    companionId: string;
    botAccountId: string;
    userId: string;
    conversationId: string;
    conversationKind: 'private' | 'group';
}
/** 同一伴随角色 + 同一机器人 + 同一用户 = 同一 principal。 */
export declare function principalKey(companionId: string, botAccountId: string, userId: string): string;
export declare function conversationKey(principalId: string, kind: 'private' | 'group', platformConversationId: string): string;
export declare function visibilityFor(kind: 'private' | 'group'): Visibility;
export declare function resolveBinding(input: BindingInput): IdentityBinding;
/** 形如 `private:123456` / `group:987654`；与 dsh-onebot-qq 的 chatId 同构。 */
export declare function parseChatId(chatId: string): {
    kind: 'private' | 'group';
    id: string;
} | null;
export declare function formatChatId(kind: 'private' | 'group', id: string): string;
export type ActivationReason = 'owner_private' | 'owner_all' | 'group_enabled' | 'group_not_enabled' | 'not_owner_chat' | 'scope_mismatch' | 'invalid_chat_id';
export interface ActivationDecision {
    active: boolean;
    reason: ActivationReason;
}
/**
 * 陪伴行为只在显式启用的会话里生效。scope=owner_private 时群聊一律不进入，
 * 即使 group 出现在 enabledGroupChats 里——两个开关都要打开。
 */
export declare function decideActivation(companion: CompanionConfig, channel: ChannelConfig, chatId: string): ActivationDecision;
/**
 * 记忆可见性过滤：private 记忆只在该 principal 的私聊可见；group 记忆可在
 * 同 principal 的群里复用但不得出现在别人的会话；shared 仅限同一 companion。
 */
export declare function canReadMemory(memoryVisibility: Visibility, binding: IdentityBinding, memoryPrincipalId: string, memoryCompanionId: string): boolean;
