/**
 * 设备—工作区台账（REQ-MOBILITY R2）。
 *
 * 只记路径、会话计数与时间；不记文件内容，也不记对话。
 * 合并口径：first_seen 取更早，last_seen 取更晚，session_count 两端累加。
 */
import type { Repositories } from './repositories.js';
export interface DeviceRecord {
    id: string;
    name: string;
    os: string;
    osVersion: string | null;
    firstSeenMs: number;
    lastSeenMs: number;
    metaJson: string | null;
}
export interface WorkspaceRecord {
    deviceId: string;
    cwd: string;
    label: string | null;
    firstSeenMs: number;
    lastSeenMs: number;
    sessionCount: number;
    note: string | null;
}
/** 只接受绝对路径形状，避免把空白或伪造串写成工作区。 */
export declare function normalizeCwd(value: unknown): string | null;
/** 宿主不同版本把工作目录放在不同字段，全部按可选读取。 */
export declare function sessionCwd(session: unknown): string | null;
export interface DeviceInput {
    id: string;
    name: string;
    os: string;
    release?: string;
    arch?: string;
}
/** 记录一次到访。同一台设备重复调用只推进 last_seen，不会重置 first_seen。 */
export declare function recordDeviceVisit(repos: Repositories, device: DeviceInput, cwd: string | null, nowMs: number): void;
/** 会话级记录：设备尚未登记时什么都不写，由启动路径先登记设备。 */
export declare function recordWorkspaceVisit(repos: Repositories, deviceId: string, cwd: string | null, nowMs: number): void;
export declare function listWorkspaces(repos: Repositories, deviceId: string): WorkspaceRecord[];
export declare function listDevices(repos: Repositories): DeviceRecord[];
export declare function getDevice(repos: Repositories, deviceId: string): DeviceRecord | null;
/** `/fish here` 的输出。当前设备排最前，其余设备只给一句摘要。 */
export declare function renderHereText(repos: Repositories, current: {
    id: string;
    name: string;
    os: string;
    release: string;
    arch: string;
    arrival: string;
    timezone: string;
}, nowMs: number): string;
/** 到达时的问候语按三态展开；`same` 保持原样，不打扰。 */
export declare function arrivalText(arrival: string, repos: Repositories, current: {
    id: string;
    name: string;
}): string;
