export interface CliIo {
    out: (text: string) => void;
    err: (text: string) => void;
}
export declare function main(argv: readonly string[], io?: CliIo): number;
/** 从 bin 入口调用时才会执行。 */
export declare function runFromProcess(): void;
