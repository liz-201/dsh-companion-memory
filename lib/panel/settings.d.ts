import { type Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
export declare function updatePanelSettings(repos: Repositories, config: Config, input: unknown, persist?: boolean, principalId?: string): void;
export declare function loadPanelSettings(repos: Repositories, config: Config): void;
