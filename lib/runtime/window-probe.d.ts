export interface WindowIdentity {
    windowId: number;
    processId: number;
    app: string;
    startedAt: string;
    foreground: boolean;
    minimized: boolean;
}
export interface WindowObservation {
    window: WindowIdentity;
    facts: {
        text: string;
        source: 'uia' | 'ocr';
        control: string;
    }[];
    image?: string;
    mediaType?: string;
    ocrError?: string | null;
    truncated?: boolean;
}
export declare function probeWindow(mode: 'windows', window?: undefined, signal?: AbortSignal): Promise<{
    windows: WindowIdentity[];
}>;
export declare function probeWindow(mode: 'uia' | 'image', window: WindowIdentity, signal?: AbortSignal): Promise<WindowObservation>;
