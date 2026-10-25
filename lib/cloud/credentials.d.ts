import type { BaiduCredentials } from './baidu-client.js';
/** This file stays outside transfer snapshots and is never returned through status. */
export declare class CredentialStore {
    readonly file: string;
    constructor(file: string);
    read(): BaiduCredentials | null;
    write(value: BaiduCredentials): void;
    disconnect(): void;
}
