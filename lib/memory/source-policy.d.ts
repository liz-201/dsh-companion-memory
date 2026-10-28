import type { RawMessage } from '../domain/types.js';
/** Keep older mislabelled bridge rows from becoming owner evidence on later reads. */
export declare function detectSourceKind(text: string, fallback: string): string;
export declare function isHumanMessage(message: Pick<RawMessage, 'role' | 'sourceKind' | 'content' | 'deletedAtMs'>): boolean;
/** SQL equivalent for bounded source selection; aliases are code-owned identifiers. */
export declare function humanSourceSql(alias?: string): string;
