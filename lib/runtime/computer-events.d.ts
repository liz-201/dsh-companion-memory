/** 采集开关由控制台配置提供；本模块默认不启用。 */
export interface ComputerEventsSettings {
    enabled: boolean;
    pollSeconds: number;
    idleThresholdSeconds: number;
    foregroundApplications: boolean;
    resources: boolean;
    network: boolean;
    watchDirectories: string[];
}
export interface ComputerEvent {
    id: string;
    kind: 'idle_return' | 'foreground_app_changed' | 'network_restored' | 'battery_low' | 'resource_pressure' | 'file_changed';
    occurredAtMs: number;
    summary: string;
    details: Record<string, string | number | boolean | null>;
}
export interface ComputerSnapshot {
    sampledAtMs: number;
    idleSeconds: number | null;
    foregroundApp: string | null;
    networkOnline: boolean | null;
    batteryPercent: number | null;
    cpuPercent: number | null;
    memoryPercent: number | null;
}
export interface ComputerEventsStatus {
    running: boolean;
    sampling: boolean;
    supported: boolean;
    lastSampleAtMs: number | null;
    error: string | null;
    snapshot: ComputerSnapshot | null;
    watchingDirectories: number;
    unavailableDirectories: string[];
}
export interface ComputerEventsOptions {
    settings: () => ComputerEventsSettings;
    onEvent: (event: ComputerEvent) => void;
    readSnapshot?: () => Promise<ComputerSnapshot>;
    now?: () => number;
}
/**
 * 纯函数：给定前后两次快照与设置，算出该发的边沿事件。
 * 首次采样（previous 为 null）只是基线，永远不产生事件。
 */
export declare function deriveEvents(previous: ComputerSnapshot | null, next: ComputerSnapshot, settings: ComputerEventsSettings, state: IdleState): ComputerEvent[];
export interface IdleState {
    batteryLow: boolean;
    resourcePressure: boolean;
}
/**
 * Windows 电脑事件采集：只读空闲时长、前台进程名、系统资源与网络，以及显式目录的文件变化。
 * 不读窗口标题、屏幕、剪贴板、键盘、文件内容或浏览历史；默认不启用。
 */
export declare class ComputerEvents {
    private readonly settings;
    private readonly onEvent;
    private readonly readSnapshot;
    private readonly now;
    private recentEvents;
    private timer;
    private watchers;
    private debounce;
    private cpuSample;
    private lastSnapshot;
    private state;
    private running;
    private sampling;
    private generation;
    private lastSampleAtMs;
    private error;
    private unavailableDirectories;
    constructor(options: ComputerEventsOptions);
    get supported(): boolean;
    start(): void;
    stop(): void;
    status(): ComputerEventsStatus;
    recent(): ComputerEvent[];
    sample(): Promise<ComputerSnapshot | null>;
    private emit;
    private scheduleNext;
    private tick;
    private syncWatchers;
    private onFile;
    private probe;
}
