/**
 * 流式协议解析状态机（任务书 §7.3、§27.4）。
 *
 * 状态：WAIT_SAY → IN_SAY → AFTER_SAY → IN_EVT → DONE / INVALID。
 *
 * 设计要求（逐条对应测试）：
 *   · 任意 chunk 切分（逐字节、逐字符、标记跨块）都能正确识别；
 *   · Unicode 代理对被切开时不丢字符；
 *   · 正文里出现协议字样（如用户让它解释 `</say>`）由 §7.2 转义规则规避，
 *     但解析器仍要能识别**未转义**的第二个 `<say>` 并判为异常；
 *   · evt 为空、畸形、重复、超长、缺闭合都要有确定结论，绝不把半截 JSON 当有效记录；
 *   · stream cancel / 非流式整包返回走同一个 finish()。
 */
export type ParserState = 'WAIT_SAY' | 'IN_SAY' | 'AFTER_SAY' | 'IN_EVT' | 'DONE' | 'INVALID';
export type ParserProblem = 'text-before-say' | 'missing-say' | 'duplicate-say' | 'duplicate-evt' | 'evt-oversize' | 'evt-unclosed' | 'evt-empty' | 'evt-malformed' | 'say-unclosed' | 'trailing-text';
export interface ParserOptions {
    /** evt 硬上限（字节）。默认 2048（§7.1「192 token / 2KB」）。 */
    evtMaxBytes?: number;
    /** 正文上限，防止模型失控时无限缓冲。默认 20000 字符。 */
    sayMaxChars?: number;
    /** 允许 AFTER_SAY 之后出现无关尾文而不判 INVALID（只记录问题）。默认 true。 */
    tolerateTrailing?: boolean;
}
export interface ParseEvent {
    type: 'say-open' | 'say-progress' | 'say-closed' | 'evt-open' | 'evt-closed' | 'done' | 'problem';
    /** say-closed 时是解码（XML 反转义）一次后的正文。 */
    text?: string;
    /** evt-closed 时是原始 JSON 文本（未解析）。 */
    raw?: string;
    problem?: ParserProblem;
    detail?: string;
}
export interface ParserResult {
    state: ParserState;
    say: string | null;
    evtRaw: string | null;
    problems: ParserProblem[];
    /** 正文里是否出现过第二个 `<say>`（用于判定模型在模仿协议）。 */
    duplicateSay: boolean;
    duplicateEvt: boolean;
    /** 未闭合时已收到的部分，供诊断（不得显示给用户）。 */
    partialEvt: string | null;
    /** 模型没按协议输出时的原始文本（§7.5 纯文本回退的唯一来源）。 */
    plainText: string | null;
}
/** §7.2：只解码一次，且只认 XML 文本实体；不做 HTML 富文本或 DOM 解析。 */
export declare function decodeSayText(text: string): string;
/** 编码时先替换 & 再替换 <，保证解码一次可逆。 */
export declare function encodeSayText(text: string): string;
export declare class StreamParser {
    private readonly evtMaxBytes;
    private readonly sayMaxChars;
    private readonly tolerateTrailing;
    private state;
    private buffer;
    private pendingHighSurrogate;
    private sayRaw;
    private sayText;
    private evtRaw;
    private evtBuffer;
    private evtBytes;
    private readonly problems;
    private duplicateSay;
    private duplicateEvt;
    private partialEvt;
    private plainText;
    private finished;
    private cancelled;
    private closedSayEmitted;
    private evtClosedEmitted;
    constructor(options?: ParserOptions);
    get currentState(): ParserState;
    /** 喂入一个流式分片；返回本片产生的语义事件（可为空数组）。 */
    feed(chunk: string): ParseEvent[];
    /**
     * 流结束（正常结束或 stream cancel 后仍调用一次）。
     * 返回最终结果；未闭合的 say 会带上已收到的正文（由调用方决定是否发送）。
     */
    finish(): {
        events: ParseEvent[];
        result: ParserResult;
    };
    /** 上游取消：保留已收到的正文，不再尝试解析尾部标记。 */
    cancel(): void;
    result(): ParserResult;
    private drain;
    /** 推进一次状态；返回是否可能还有进展。 */
    private step;
    private closeOut;
}
/** 一次性解析（非流式返回、测试与回放用）。 */
export declare function parseComplete(text: string, options?: ParserOptions): ParserResult & {
    events: ParseEvent[];
};
