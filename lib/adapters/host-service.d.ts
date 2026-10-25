import type { HostContext } from './dsh-adapter.js';
/** Cordis optional services must be discovered through get(), not proxy properties. */
export declare function hostService(ctx: HostContext, name: string): unknown;
