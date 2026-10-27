import type { BaiduCredentials, BaiduTokens } from './baidu-client.js';
/** This file stays outside transfer snapshots and is never returned through status. */
export declare const CONNECTION_FORMAT = "dsh-companion-memory/connection@1";
export interface ConnectionFields {
    appKey: string;
    secretKey: string;
    appFolder: string;
}
export interface ConnectionPayload extends ConnectionFields {
    format: string;
    tokens?: BaiduTokens;
}
export interface ConnectionSummary {
    appKey: string;
    appFolder: string;
    hasTokens: boolean;
    expiresAtMs: number | null;
}
/**
 * 应用信息与目录名的唯一校验入口：连接页、凭据文件、导入的连接配置都必须走这里，
 * 否则三处规则会各自漂移。
 */
export declare function validateConnectionFields(input: Record<string, unknown>, message?: string): ConnectionFields;
/** 令牌只接受已知的三个字段，多余键一律丢弃，避免把任意内容写回凭据文件。 */
export declare function validateTokens(value: unknown, message?: string): BaiduTokens | undefined;
/**
 * 导出连接配置。默认不含令牌：两台机器共用同一 refreshToken 时，百度若在刷新时轮换
 * refreshToken，先刷新的一台会把另一台踢下线，所以带令牌必须是显式选择。
 */
export declare function serializeConnection(credentials: BaiduCredentials, options?: {
    includeTokens?: boolean;
}): string;
/** 解析粘贴或导入的连接配置；任何缺失都报同一句中文，避免把原始异常带到界面上。 */
export declare function parseConnection(text: string): BaiduCredentials;
/** 给界面用的安全摘要：绝不解出完整密钥或令牌。 */
export declare function describeConnection(credentials: BaiduCredentials): ConnectionSummary;
export declare class CredentialStore {
    readonly file: string;
    constructor(file: string);
    read(): BaiduCredentials | null;
    write(value: BaiduCredentials): void;
    disconnect(): void;
}
