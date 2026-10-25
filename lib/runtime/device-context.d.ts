import type { Repositories } from '../storage/repositories.js';
export declare function inspectDevice(): {
    id: string;
    name: string;
    os: NodeJS.Platform;
    release: string;
    arch: NodeJS.Architecture;
    reliable: boolean;
};
export declare function registerDevice(repos: Repositories, device?: {
    id: string;
    name: string;
    os: NodeJS.Platform;
    release: string;
    arch: NodeJS.Architecture;
    reliable: boolean;
}, nowMs?: number): {
    arrival: string;
    timezone: string;
    runtime: string;
    text: string;
    id: string;
    name: string;
    os: NodeJS.Platform;
    release: string;
    arch: NodeJS.Architecture;
    reliable: boolean;
};
