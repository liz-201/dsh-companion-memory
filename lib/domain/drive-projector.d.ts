export interface DriveParameters {
    contactTauHours: number;
    responseRelief: number;
    cap: number;
}
export interface DriveState {
    atMs: number;
    contact: number;
    exploration: number;
    load: number;
    responses: number;
}
export declare const DRIVE_DEFAULTS: DriveParameters;
/** Pure projection; never save repeated read projections as new source events. */
export declare function projectDrives(state: DriveState, atMs: number, parameters?: DriveParameters): DriveState;
export declare function respondDrive(state: DriveState, atMs: number, parameters?: DriveParameters): DriveState;
