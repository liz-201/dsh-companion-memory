import type { Config } from '../config.js';
import type { IdentityBinding } from '../domain/types.js';
import type { Repositories } from '../storage/repositories.js';
export declare const asksAboutInterface: (query: string) => boolean;
/** Local observations are data with a short lifetime, never owner messages or durable memories. */
export declare function perceptionContext(repos: Repositories, config: Config, binding: IdentityBinding, query: string, nowMs: number): string;
