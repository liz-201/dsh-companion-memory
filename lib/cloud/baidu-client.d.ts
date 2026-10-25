/**
 * 百度网盘 PCS / OAuth 客户端（无外部依赖，fetch 依赖注入）。
 *
 * 约定：
 * - 只允许官方 HTTPS 主机，重定向也逐跳校验；
 * - 所有对外抛出的错误都是 `BaiduError`，消息里只有固定文案与错误码，
 *   不回显响应 body、token、secret 或带签名的 URL；
 * - 传输上限 512MiB，分片 4MiB，分片 md5 与 block_list 严格对齐；
 * - 远程 path 必须落在 `/apps/${appFolder}/` 之内。
 */
export interface BaiduTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAtMs?: number;
}
export interface BaiduCredentials {
    appKey: string;
    secretKey: string;
    appFolder: string;
    tokens?: BaiduTokens;
}
export interface BaiduRemoteFile {
    id: number;
    name: string;
    path: string;
    size: number;
    modifiedAtMs: number;
}
export declare class BaiduError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * 本仓库 tsconfig 只有 ES2023 lib，且 `_vendor/@types` 未随 undici-types，
 * 全局 `Response`/`RequestInit` 会被 inspector 协议的同名接口遮蔽。
 * 这里用结构化最小接口描述真正用到的成员；真实 fetch 天然满足它。
 */
export interface BaiduResponseBody {
    getReader(): {
        read(): Promise<{
            done: boolean;
            value?: Uint8Array;
        }>;
        cancel(reason?: unknown): Promise<void>;
    };
}
export interface BaiduHttpResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly headers: {
        get(name: string): string | null;
    };
    readonly body?: BaiduResponseBody | null;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}
export interface BaiduRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    redirect?: 'follow' | 'manual' | 'error';
    signal?: AbortSignal;
}
export type BaiduFetch = (input: string, init?: BaiduRequestInit) => Promise<BaiduHttpResponse>;
export interface BaiduClientOptions {
    credentials: BaiduCredentials;
    fetchImpl?: typeof fetch;
    saveTokens?: (tokens: BaiduTokens) => Promise<void> | void;
    now?: () => number;
    timeoutMs?: number;
    /** 单次传输上限，默认 512MiB；测试用它验证边读边判上限，不改变生产默认。 */
    maxTransferBytes?: number;
}
export declare class BaiduClient {
    private readonly credentials;
    private readonly fetchImpl;
    private readonly saveTokens;
    private readonly clock;
    private readonly timeoutMs;
    private readonly maxTransferBytes;
    private readonly appFolder;
    private tokens;
    private refreshing;
    private readonly requests;
    private cancelled;
    cancel(): void;
    constructor(options: BaiduClientOptions);
    beginAuthorization(): Promise<{
        deviceCode: string;
        userCode: string;
        verificationUrl: string;
        expiresIn: number;
        interval: number;
    }>;
    /** 单次轮询：未授权时抛 `authorization_pending`，由调用方自己控制节奏。 */
    completeAuthorization(deviceCode: string): Promise<BaiduTokens>;
    list(directory: string): Promise<BaiduRemoteFile[]>;
    upload(path: string, bytes: Uint8Array): Promise<BaiduRemoteFile>;
    /**
     * precreate 响应里的 block_list 是**还需要上传的分片序号**（官方 upload_precreate.go
     * 是 []int），不是 md5 列表；字段缺省表示所有分片都要传。
     */
    private partsToUpload;
    /** 秒传没有 uploadid 可 create，只能靠 precreate 的 fs_id 或列目录核对。 */
    private resolveRapidUpload;
    private toCreatedFile;
    download(file: BaiduRemoteFile): Promise<Uint8Array>;
    private transportError;
    /**
     * 一次逻辑请求 = 一个超时预算，**包含读响应体**。
     * 计时器只在 body 读完（或读失败）之后才清，所以「头立刻回来、body 一直不来」
     * 也会被 abort 成 timeout，而不是无限等下去。重定向逐跳校验并共用同一预算。
     */
    private request;
    private readJson;
    /** 边读边累计，超过上限立刻取消流并失败，不等整个 body 落地。 */
    private readCapped;
    private postForm;
    /**
     * 调 pan.baidu.com 文件接口。`tolerate` 里的 errno 原样返回给调用方判断，
     * 其余非零 errno 一律抛脱敏错误；鉴权类 errno 只刷新重试一次。
     */
    private callFileApi;
    private uploadPart;
    private tokensFrom;
    private persistTokens;
    private isFresh;
    private accessToken;
    /** 并发刷新只发一次请求，其余调用等同一个 promise。 */
    private refreshTokens;
    private doRefresh;
    private appRoot;
    private normalizeRemote;
    private assertRemoteDirectory;
    private assertRemoteFile;
    private toRemoteFile;
    private ensureDirectory;
}
