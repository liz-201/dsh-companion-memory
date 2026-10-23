import { type TurnOutcome } from './runtime/turn-coordinator.js';
import { type FishCommandResult } from './commands/handlers.js';
import { type HostContext } from './adapters/dsh-adapter.js';
import { type CompatibilityReport } from './adapters/compatibility.js';
import type { DeliveryReceipt } from './domain/types.js';
/** Cordis 插件名。 */
export declare const name = "dsh-companion-memory"; /** * 依赖的服务。 *
* 全部声明为 optional：缺 `systemPrompt` 就退化成「把人格并进消息体」，
* 缺 `llm` 就退化成 plain 模式，缺 `commands` 只是没有斜杠命令——
* 但插件本身必须还能加载并如实报告降级（§18.3）。 */
export declare const inject: {
    required: string[];
    optional: string[];
};
/** 宿主 ctx 的最小结构（其余成员一律按 unknown 处理，避免和宿主类型强绑定）。 */
interface PluginContext extends HostContext {
    systemPrompt?: {
        section(options: {
            name: string;
            order: number;
            interpolate?: boolean;
            text: () => string;
        }): () => void;
        getSectionOrder?(name: string): number;
    };
    commands?: {
        register(definition: {
            name: string;
            description: string;
            input?: {
                hint?: string;
            };
            handler: (input: {
                agent?: unknown;
                rawInput?: unknown;
            }) => {
                kind: 'success' | 'error';
                text: string;
            };
        }): unknown;
    };
    webServer?: {
        register(route: {
            kind: string;
            path: string;
            handler: (req: unknown, res: unknown) => void;
        }): () => void;
    };
    get?(service: string): unknown;
    provide?(service: string, value: unknown): void;
    emit?(event: string, ...args: unknown[]): void;
    effect?(callback: () => (() => void) | void, label?: string): void;
    on?(event: string, callback: (...args: unknown[]) => void): void;
}
/** 交给 dsh-onebot-qq 桥的入站消息。 */
export interface CompanionInbound {
    /** `private:123` / `group:456`，与桥的 chatId 同构。 */
    chatId: string;
    botAccountId?: string;
    userId?: string;
    send?: (text: string, turnId: string) => Promise<DeliveryReceipt>;
    text: string;
    platformMessageKey?: string | null;
    occurredAtMs?: number;
    /** 宿主会话 id；有就记下来，便于 `/fish` 反查。 */
    sessionId?: string | null;
    sourceKind?: string | null;
}
export interface CompanionInboundResult {
    /** 是否被本插件接手；false 时桥应该走它自己的默认路径。 */
    handled: boolean;
    /** 本次已经替桥发过正文（桥不应再发一遍，§13.2 默认抑制）。 */
    replySuppressed: boolean;
    outcome: TurnOutcome | null;
    reason?: string;
}
/** 插件对外暴露的服务；桥、CLI、诊断页都通过它取状态。 */
export interface CompanionService {
    readonly version: string;
    accepts(chatId: string): boolean;
    handleInbound(input: CompanionInbound): Promise<CompanionInboundResult>;
    handleCommand(input: {
        text: string;
        chatId: string;
        botAccountId?: string;
    }): FishCommandResult;
    isCommand(text: string): boolean;
    status(): Record<string, unknown>;
    compatibility(): CompatibilityReport;
    /** 该 turn 的正文是否已经由本插件发出（桥据此抑制重复发送）。 */
    consumed(turnId: string): boolean;
    shutdown(): Promise<void>;
}
/** 装配插件。 */
export declare function apply(ctx: PluginContext, rawConfig?: unknown): void;
export default apply;
