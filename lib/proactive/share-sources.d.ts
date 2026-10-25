import type { Config } from '../config.js';
import type { Repositories } from '../storage/repositories.js';
import type { IdentityBinding } from '../domain/types.js';
interface ShareResponse {
    ok: boolean;
    headers: {
        get(name: string): string | null;
    };
    body: {
        getReader(): {
            read(): Promise<{
                done: boolean;
                value: Uint8Array;
            }>;
            cancel(): Promise<void>;
        };
    } | null;
}
type ShareFetch = (url: URL, options: {
    redirect: 'error';
    signal: AbortSignal;
}) => Promise<ShareResponse>;
/** Parse bounded feed entries independently, so a feed heading cannot stand in for an article. */
export declare function shareArticles(raw: string, source: URL): {
    title: string;
    url: string;
    excerpt: string;
}[];
export declare function matchesInterest(claim: string, material: string): boolean;
/** Only configured public URLs, bounded responses, no ambient browsing or private-file discovery. */
export declare class ShareSources {
    private readonly repos;
    private readonly config;
    private readonly fetcher;
    constructor(repos: Repositories, config: Config, fetcher?: ShareFetch);
    scan(bindings: readonly IdentityBinding[], nowMs: number): Promise<void>;
}
export {};
