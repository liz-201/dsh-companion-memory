import type { Config } from '../config.js';
import type { Database } from '../storage/database.js';
import { type ImportReport } from '../storage/portable.js';
import { CredentialStore } from './credentials.js';
import { type BaiduCredentials, type BaiduRemoteFile } from './baidu-client.js';
export interface CloudTransport {
    cancel?(): void;
    list(directory: string): Promise<BaiduRemoteFile[]>;
    upload(path: string, bytes: Uint8Array): Promise<BaiduRemoteFile>;
    download(file: BaiduRemoteFile): Promise<Uint8Array>;
}
export interface TransferStatus {
    enabled: boolean;
    connected: boolean;
    busy: boolean;
    ready: boolean;
    lastSyncAtMs: number | null;
    lastExport: string | null;
    imported: number;
    conflicts: number;
    lineageMissing: boolean;
    error: string | null;
}
/** Per-device snapshots avoid cloud last-writer-wins erasing an offline peer. */
export declare class MemoryTransfer {
    private readonly db;
    private readonly config;
    private readonly deviceId;
    readonly credentials: CredentialStore;
    readonly directory: string;
    private readonly repos;
    private readonly clientFactory;
    private readonly fetchImpl;
    private pending;
    private timer;
    private startupDeadline;
    private stopped;
    private finishedStartup;
    private startup;
    private lastSyncAtMs;
    private lastExport;
    private imported;
    private conflicts;
    private missingLineage;
    private error;
    private changedDuringUpload;
    private authorization;
    private credentialRevision;
    private activeTransport;
    constructor(db: Database, config: Config, deviceId: string, options?: {
        credentialFile?: string;
        clientFactory?: (credentials: BaiduCredentials) => CloudTransport;
        fetchImpl?: typeof fetch;
    });
    get ready(): Promise<void>;
    get isReady(): boolean;
    private client;
    private enabled;
    status(): TransferStatus;
    start(): void;
    stop(): Promise<void>;
    /** Always produces a complete, directly importable file; no raw DB/WAL copying. */
    exportLocal(): {
        file: string;
        id: string;
        messages: number;
        memories: number;
        upload: string;
    };
    importFile(file: string): ImportReport;
    importBytes(bytes: Uint8Array): ImportReport;
    beginAuthorization(input: {
        appKey: string;
        secretKey: string;
        appFolder: string;
    }): Promise<{
        userCode: string;
        verificationUrl: string;
        expiresIn: number;
        interval: number;
    }>;
    finishAuthorization(): Promise<TransferStatus>;
    disconnect(): Promise<void>;
    sync(): Promise<TransferStatus>;
    private runSync;
}
