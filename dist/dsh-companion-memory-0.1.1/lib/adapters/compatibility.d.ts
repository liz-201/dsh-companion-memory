/**
 * 宿主兼容层（任务书 §13.1、§13.3、§2.2）。
 *
 * 职责只有一个：把「宿主到底给了什么」查清楚，并给出可执行的降级结论。
 * 这里**不调用**宿主服务，只做能力探测；真正的调用在 dsh-adapter。
 *
 * 探测原则：
 *   · 属性访问一律包在 try/catch 里——宿主服务在装配期可能是 getter；
 *   · 缺失当缺失，不用「大概能用」的假设；
 *   · 每个降级结论都带人话说明，直接进 doctor 与 docs/COMPATIBILITY.md。
 */
export type CapabilityId = 'systemPrompt' | 'tools' | 'agents' | 'sessions' | 'commands' | 'llm' | 'systemPromptEvent' | 'agentLoopEvent' | 'webServer' | 'onebotHttp' | 'chatSessionsFile';
export interface Capability {
    id: CapabilityId;
    available: boolean;
    /** 可用于实现的能力等级；缺省 null 表示不可用。 */
    level: 'full' | 'partial' | 'none';
    detail: string;
}
export interface CompatibilityReport {
    hostVersion: string | null;
    nodeVersion: string;
    capabilities: Capability[];
    /** 无法实现、必须向用户如实说明的功能。 */
    blocked: string[];
    /** 可以跑但质量下降的功能。 */
    degraded: string[];
    /** 与任务书 §13 对照后的结论：实现的是哪一档交付。 */
    delivery: 'full' | 'plain-body-only';
}
/** 只读探测宿主能力；任何异常都当成「不可用」，不让装配因为探测失败而崩。 */
export declare function probeCapabilities(ctx: unknown, options?: {
    onebotHttpBase?: string;
    chatSessionsFile?: string;
}): CompatibilityReport;
/** doctor 用：把报告压成几行文本。 */
export declare function describeCompatibility(report: CompatibilityReport): string;
