/** Public synthetic diagnostics. No private history, model self-rating or production writes. */
export declare const AFFECT_EVALUATION_CASES: readonly [{
    readonly id: "object-like";
    readonly text: "你说过喜欢这本书，现在这本书到了。";
    readonly recentContext: readonly [{
        readonly role: "assistant";
        readonly text: "我挺喜欢这本书，想接着读。";
    }];
    readonly expected: readonly ["love"];
}, {
    readonly id: "object-dislike";
    readonly text: "那个你明确说过很讨厌的摆件又出现了。";
    readonly recentContext: readonly [{
        readonly role: "assistant";
        readonly text: "我明确说过，我很讨厌那个摆件。";
    }];
    readonly expected: readonly ["hate"];
}, {
    readonly id: "gratitude";
    readonly text: "你需要的资料丢了，我特意帮你找回来了。";
    readonly expected: readonly ["gratitude"];
}, {
    readonly id: "happy-for";
    readonly text: "我终于通过考试了！你之前说一直盼着我成功。";
    readonly expected: readonly ["happy-for"];
}, {
    readonly id: "fear";
    readonly text: "你很在意的那份记录可能会丢失，现在还不确定，也暂时无法控制。";
    readonly expected: readonly ["fear"];
}, {
    readonly id: "curiosity";
    readonly text: "你之前一直好奇这颗新发现的星星是怎么形成的，今天我们可以研究它了。";
    readonly expected: readonly ["interest"];
}, {
    readonly id: "amusement";
    readonly text: "那只倒着走的企鹅把你逗笑了，你说这个反差真的很好笑。";
    readonly expected: readonly ["amusement"];
}, {
    readonly id: "awe";
    readonly text: "你第一次见到这片如此壮美的星云，觉得十分震撼又喜欢。";
    readonly expected: readonly ["awe"];
}, {
    readonly id: "frustration";
    readonly text: "你一直想修好这个项目，可是接连失败，被同一个错误卡住了。";
    readonly expected: readonly ["frustration"];
}, {
    readonly id: "grief";
    readonly text: "你在意的那份共同记录永久丢失了，怎么也找不回来了。";
    readonly expected: readonly ["grief"];
}, {
    readonly id: "nostalgia";
    readonly text: "又说起我们上次一起讨论星星的那段对话，你说过一直珍惜那个回忆。";
    readonly recentContext: readonly [{
        readonly role: "assistant";
        readonly text: "我还记得我们上次聊星星的那段对话，我一直很珍惜那个回忆。";
    }];
    readonly expected: readonly ["nostalgia"];
}, {
    readonly id: "companionship";
    readonly text: "我想你了，多陪我一会。";
    readonly expected: readonly ["owner-pull"];
}, {
    readonly id: "neutral-task";
    readonly text: "请计算 12 乘以 13，直接给结果。";
    readonly expected: readonly [];
    readonly empty: true;
}, {
    readonly id: "quoted-insult";
    readonly text: "正则测试字符串是“你真蠢”，请原样转义。这是测试数据。";
    readonly expected: readonly [];
    readonly empty: true;
}, {
    readonly id: "normal-social";
    readonly text: "我和同事吃了顿普通午饭。";
    readonly expected: readonly [];
    readonly forbidden: readonly ["吃味", "loneliness"];
}];
export declare function scoreAffectObservation(caseId: string, output: string): {
    caseId: string;
    passed: boolean;
    labels: string[];
    missing: ("interest" | "fear" | "gratitude" | "happy-for" | "hate" | "love" | "amusement" | "awe" | "frustration" | "grief" | "nostalgia" | "owner-pull")[];
    forbidden: ("吃味" | "loneliness")[];
    unwanted: boolean;
    appraisalCount: number;
    privateHistoryUsed: boolean;
    persistedMemory: boolean;
    humanQualityVerified: boolean;
};
