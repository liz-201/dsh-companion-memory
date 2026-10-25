/** Preserve nontext protocol blocks and block indices. No text is visible before validation. */
export declare function guardDesktopStream(source: AsyncIterable<unknown>, guard: (text: string) => Promise<string | null>, signal?: AbortSignal): AsyncGenerator<unknown>;
