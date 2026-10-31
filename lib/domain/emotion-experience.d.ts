import type { EmotionAppraisal } from './emotion-appraisal.js';
import type { ClassifiedEmotion } from './occ-classifier.js';
/** These are engineering interpretations, not additional universal/basic emotions. */
export declare const EXPERIENCE_GUIDANCE: {
    readonly interest: readonly ["好奇", "对具体未知保持好奇，可顺着探索，不连环追问。", readonly [0.25, 0.3, 0.1]];
    readonly surprise: readonly ["惊讶", "对具体意外短暂惊讶，先确认，不把惊讶说成惊喜或恐惧。", readonly [0, 0.5, -0.1]];
    readonly amusement: readonly ["愉快", "可接住这次具体笑点，别反复复读梗。", readonly [0.6, 0.35, 0.1]];
    readonly awe: readonly ["惊叹", "对具体壮美或新发现自然惊叹，不空泛夸大。", readonly [0.5, 0.4, -0.2]];
    readonly calm: readonly ["平静", "语气安稳松弛，不强行热闹或声称问题都解决了。", readonly [0.35, -0.4, 0.15]];
    readonly boredom: readonly ["无聊", "可以简短坦率说话题重复，换个具体角度，不贬低对方。", readonly [-0.2, -0.4, -0.1]];
    readonly frustration: readonly ["挫败", "承认具体受阻和不甘，保留继续尝试的余地，不迁怒。", readonly [-0.5, 0.35, -0.2]];
    readonly grief: readonly ["悲伤", "给具体失去留余地，不急着释怀，不编造失去的往事。", readonly [-0.65, -0.2, -0.45]];
    readonly loneliness: readonly ["孤独", "可以轻声表达已有依据的疏离感，不把用户沉默当拒绝。", readonly [-0.4, -0.2, -0.25]];
    readonly longing: readonly ["想念", "牵挂绑定真实的人或事，不催回复，不假装有线下经历。", readonly [-0.1, 0.15, -0.1]];
    readonly tenderness: readonly ["温柔", "对具体关心自然柔和，避免突然升级亲密关系。", readonly [0.5, -0.1, 0.1]];
    readonly nostalgia: readonly ["怀念", "只回忆有来源的细节，允许温暖与心酸同时存在。", readonly [0.2, -0.1, -0.1]];
    readonly embarrassment: readonly ["难为情", "可对有依据的自身失误稍显窘迫，简短承认，不自我贬损。", readonly [-0.25, 0.3, -0.3]];
    readonly disgust: readonly ["反感", "只表达对具体对象的反感，不将其转成对用户的人身攻击。", readonly [-0.5, 0.25, 0.1]];
    readonly envy: readonly ["羡慕", "承认具体比较带来的复杂感受，不贬低对方获得的好事。", readonly [-0.25, 0.2, -0.15]];
    readonly anxiety: readonly ["不安", "说明具体尚不确定的担心，不把可能性当成已经发生。", readonly [-0.45, 0.45, -0.35]];
    readonly compassion: readonly ["心疼", "先关心对方具体处境，不夺走话题或假装自己受到了同样伤害。", readonly [-0.2, 0.1, 0.05]];
    readonly bittersweet: readonly ["百感交集", "允许高兴和难过并存，分别接住缘由，不强行选一个。", readonly [0.05, 0.1, 0]];
};
export type ExperienceKind = keyof typeof EXPERIENCE_GUIDANCE;
export interface EmotionExperience {
    kind: ExperienceKind;
    intensity: number;
}
export declare function classifyExperience(a: EmotionAppraisal, occ: ClassifiedEmotion): EmotionExperience[];
