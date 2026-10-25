interface EntryContext {
    on?(event: string, listener: (...args: unknown[]) => unknown): unknown;
    get?(name: string): unknown;
}
/** The host renders this same injection table in both Web and Electron Desktop. */
export declare function mountPanelEntry(ctx: EntryContext, directory: string, getOrigin: () => string): () => void;
export {};
