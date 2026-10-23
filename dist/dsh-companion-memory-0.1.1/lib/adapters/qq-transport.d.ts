/**
 * QQ 发送通道（任务书 §13.2、§14.4）。
 *
 * 这里只做一件事：把一段文本按 OneBot 11 协议发给指定会话，并如实返回回执。
 * 三条硬规矩：
 *   · 平台明确拒绝（HTTP 非 2xx、retcode 非 0）→ rejected，可分类重试；
 *   · 超时 / 连接中断 → unknown（消息可能已经到了），**绝不自动重发**；
 *   · 回执里的 platformMessageId 只用于对账，不当作远端幂等键（§14.4）。
 *
 * 会话映射复用 dsh-onebot-qq 的 `chat-sessions.json`（chatId → sessionId），
 * 这样主动消息和对应用户的 Agent 会话是同一条线，不另起第二个入站消费者。
 */
import type { DeliveryReceipt } from '../domain/types.js';
export interface ChatTarget {
    kind: 'private' | 'group';
    id: string;
}
/**
 * 只声明本项目真正用到的那一小块 HTTP 能力。
 *
 * 不直接用全局 etch 的类型：宿主注入的类型库里 undici-types 未必在场，
 * 缺了它全局 Response 会退化成空接口，
esponse.ok /
esponse.text()
 * 就编译不过。这里按结构声明，注入任意兼容实现即可（测试里直接塞桩）。
 */
export interface FetchResponseLike {
    ok: boolean;
    status: number;
    text(): Promise<string>;
}
export interface FetchInitLike {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}
export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;
export interface QqTransportOptions {
    httpBase: string;
    accessToken?: string;
    /** 单次请求超时；超时一律判 unknown，不重发。 */
    timeoutMs?: number;
    /** 单条消息最大字符数，超出按段落切开分次发送。 */
    maxChars?: number;
    fetchImpl?: FetchLike;
}
export interface QqHealth {
    ok: boolean;
    detail: string;
    selfId: string | null;
}
/** 把 `private:123` / `group:456` 拆成 OneBot 需要的参数。 */
export declare function parseTarget(chatId: string): ChatTarget | null;
/** 读 chat-sessions.json；坏文件当空映射，不让装配因为读配置而崩。 */
export declare function readChatSessions(file: string): Record<string, string>;
/** 反查：某个 Agent 会话对应哪个 chat（主动消息要发回原会话）。 */
export declare function chatForSession(file: string, sessionId: string): string | null;
/** 长文本按段落切；不切断句子是发送层的事，这里只保证单条不超限。 */
export declare function splitMessage(text: string, maxChars: number): string[];
export declare class QqTransport {
    private readonly base;
    private readonly token;
    private readonly timeoutMs;
    private readonly maxChars;
    private readonly fetchImpl;
    private lastError;
    constructor(options: QqTransportOptions);
    /** 是否配了可用的 HTTP 端点。 */
    get configured(): boolean;
    get lastFailure(): string | null;
    /** 发一段文本。返回的回执是「平台到底怎么说」，不是「我们试过了」。 */
    sendText(chatId: string, text: string): Promise<DeliveryReceipt>;
    private sendChunk;
    /** 探活：get_login_info 能回 ok 才算在线。 */
    health(): Promise<QqHealth>;
    private headers;
}
