import type { RawMessage } from '../domain/types.js';
/** Only trusted human channels may teach owner preferences or affect. Unknown sources fail closed. */
export declare function isHumanMessage(message: RawMessage): boolean;
/**
 * 入口标记：把机器投递的文本从人类来源里摘出去。
 * `isHumanMessage` 的白名单只认 dsh/desktop/qq，所以这里标成 `codex-bridge`
 * 后，习惯学习、事实提取、整理批次都会自动跳过它。
 */
export declare function detectSourceKind(text: string, fallback: string): string;
