import type { Config } from '../config.js';
import type { Database } from '../storage/database.js';
import { type ImportReport } from '../storage/portable.js';
import { CredentialStore } from './credentials.js';
import { type BaiduCredentials, type BaiduRemoteFile } from './baidu-client.js';
import { type OwnerMergePreview } from '../storage/owner-merge.js';
export interface CloudTransport {
    cancel?(): void;
    list(directory: string): Promise<BaiduRemoteFile[]>;
    upload(path: string, bytes: Uint8Array): Promise<BaiduRemoteFile>;
    download(file: BaiduRemoteFile): Promise<Uint8Array>;
}
/** 云端另有记忆库时给界面的结构化线索：不阻断同步，也不静默。 */
export interface ForeignLibrary {
    path: string;
    companionDigest: string;
    ownerDigest: string;
    updatedAtMs: number;
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
    foreignLibraries: ForeignLibrary[];
    notice: string | null;
}
export interface LibraryManifestFile {
    path: string;
    size: number;
    checksum: string;
    deviceId: string;
    updatedAtMs: number;
    modifiedAtMs: number;
}
export interface LibraryManifest {
    format: string;
    companionId: string;
    ownerId: string;
    updatedAtMs: number;
    files: LibraryManifestFile[];
}
/** 清单只放定位与校验信息：任何令牌、密钥都不允许进这个文件（它会留在网盘上）。 */
export declare const LIBRARY_MANIFEST = "manifest.json";
export declare const MANIFEST_FORMAT = "dsh-companion-memory/library@1";
export declare function libraryManifestPath(directory: string): string;
/**
 * 只保留已知字段：清单里任何多余键（尤其凭据）都会被丢弃，重新上传时也不会被带回去。
 */
export declare function sanitizeManifest(raw: unknown): LibraryManifest | null;
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
    private readonly assertMergeIdle;
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
    private foreign;
    private notice;
    private foreignScanAt;
    private changedDuringUpload;
    private authorization;
    private credentialRevision;
    private activeTransport;
    private ownerMergeCandidate;
    private ownerMergeBusy;
    private readonly ownerMergePreviews;
    constructor(db: Database, config: Config, deviceId: string, options?: {
        credentialFile?: string;
        clientFactory?: (credentials: BaiduCredentials) => CloudTransport;
        fetchImpl?: typeof fetch;
        assertMergeIdle?: () => void;
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
    /** Stage the exact source file; preview rolls every simulated database change back. */
    prepareOwnerMerge(bytes: Uint8Array): OwnerMergePreview & {
        previewToken: string;
        expiresAtMs: number;
    };
    confirmOwnerMerge(previewToken: string, confirmation: string): ImportReport & {
        sourceArchive: string;
    };
    /** Download only the conflicting library found by normal sync; confirmation remains separate. */
    prepareCloudOwnerMerge(): Promise<OwnerMergePreview & {
        previewToken: string;
        expiresAtMs: number;
    }>;
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
    /** 导出连接配置：默认不带令牌，避免两台机器争用同一个 refreshToken 互相踢下线。 */
    exportConnection(options?: {
        includeTokens?: boolean;
    }): string;
    /** 导入连接配置：写凭据文件、开启云同步，然后立刻同步一次。 */
    importConnection(text: string): Promise<TransferStatus>;
    sync(): Promise<TransferStatus>;
    private runSync;
    /** 清单只是定位与校验信息，读不到就不跳过下载，绝不因为清单损坏而漏导入。 */
    private readManifest;
    private writeManifest;
    /**
     * companion.id 不一致时云端目录不同，`list` 只会返回空列表并静默上传到新目录，
     * 所以这里按父目录下各子目录的清单比对，把差异显式报给界面。
     */
    private detectForeignLibraries;
}
