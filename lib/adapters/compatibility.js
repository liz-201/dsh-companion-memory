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
import { hostService } from './host-service.js';
function has(ctx, key) {
    try {
        return hostService(ctx, key) != null;
    }
    catch {
        return false;
    }
}
function callable(value, method) {
    if (value === null || value === undefined)
        return false;
    try {
        return typeof value[method] === 'function';
    }
    catch {
        return false;
    }
}
/** 只读探测宿主能力；任何异常都当成「不可用」，不让装配因为探测失败而崩。 */
export function probeCapabilities(ctx, options = {}) {
    const root = (ctx ?? {});
    const capabilities = [];
    const blocked = [];
    const degraded = [];
    const systemPrompt = hostService(root, 'systemPrompt');
    const systemPromptOk = callable(systemPrompt, 'section') || callable(systemPrompt, 'variable');
    capabilities.push({
        id: 'systemPrompt',
        available: systemPromptOk,
        level: systemPromptOk ? 'full' : 'none',
        detail: systemPromptOk ? 'ctx.systemPrompt 可注册段落/变量' : '请求自带有界 system 消息，不注册全局提示段',
    });
    const tools = hostService(root, 'tools');
    const toolsOk = callable(tools, 'register');
    capabilities.push({
        id: 'tools',
        available: toolsOk,
        level: toolsOk ? 'full' : 'none',
        detail: toolsOk ? 'ctx.tools.register 可用' : '没有 tools 服务：fish_* 工具不注册，命令走 QQ 桥',
    });
    const sessions = hostService(root, 'sessions');
    const agentsOk = has(root, 'agents');
    capabilities.push({
        id: 'agents',
        available: agentsOk,
        level: agentsOk ? 'full' : 'none',
        detail: agentsOk ? 'ctx.agents 存在，可按 Agent 作用域安装适配' : '普通会话按事件携带的 Agent/session 隔离，QQ 按白名单绑定',
    });
    const sessionsOk = sessions !== undefined && sessions !== null;
    capabilities.push({
        id: 'sessions',
        available: sessionsOk,
        level: sessionsOk ? 'partial' : 'none',
        detail: sessionsOk ? 'ctx.sessions 存在（历史投影/会话读写能力需逐个方法确认）' : '没有 sessions 服务：本地消息表是唯一历史来源',
    });
    const commands = hostService(root, 'commands');
    const commandsOk = callable(commands, 'register');
    capabilities.push({
        id: 'commands',
        available: commandsOk,
        level: commandsOk ? 'full' : 'none',
        detail: commandsOk ? 'ctx.commands.register 可用，可注册 /fish 子命令' : '没有 commands 服务：/fish 只能由 QQ 桥的斜杠路由分发',
    });
    const llm = hostService(root, 'llm');
    const llmOk = callable(llm, 'stream');
    capabilities.push({
        id: 'llm',
        available: llmOk,
        level: llmOk ? 'full' : 'none',
        detail: llmOk ? 'ctx.llm.stream 可用；route 在每次调用前重新解析' : '没有 llm 目录：模型名必须由宿主注入',
    });
    const onEvent = callable(root, 'on');
    capabilities.push({
        id: 'systemPromptEvent',
        available: onEvent,
        level: onEvent ? 'full' : 'none',
        detail: onEvent ? "ctx.on('system-prompt/assemble') 可挂装配钩子" : '无法订阅装配事件：只能静态注册段落',
    });
    capabilities.push({
        id: 'agentLoopEvent',
        available: onEvent,
        level: onEvent ? 'partial' : 'none',
        detail: onEvent ? '已支持 agent/inbox/claimed 与 session/event；需宿主实际发送事件' : '没有事件接口：普通 DSH 会话无法自动记录，QQ 桥仍可提供回合数据',
    });
    const webServer = hostService(root, 'webServer');
    const webOk = callable(webServer, 'register');
    capabilities.push({
        id: 'webServer',
        available: webOk,
        level: webOk ? 'partial' : 'none',
        detail: webOk ? 'webServer.register 可用（本地状态页）' : '没有 webServer：不提供 HTTP 状态页',
    });
    const onebotOk = typeof options.onebotHttpBase === 'string' && /^https?:\/\//.test(options.onebotHttpBase);
    capabilities.push({
        id: 'onebotHttp',
        available: onebotOk,
        level: onebotOk ? 'partial' : 'none',
        detail: onebotOk ? '配置了 OneBot HTTP 端点：主动消息可直发' : '未配置 OneBot HTTP 端点：主动消息只写 outbox，等桥接层代发',
    });
    if (!onebotOk)
        degraded.push('无 OneBot HTTP 端点：主动消息停留在 outbox（pending），不会宣称已送达');
    const fileOk = typeof options.chatSessionsFile === 'string' && options.chatSessionsFile.length > 0;
    capabilities.push({
        id: 'chatSessionsFile',
        available: fileOk,
        level: fileOk ? 'partial' : 'none',
        detail: fileOk ? '可读 dsh-onebot-qq 的 chat→session 映射' : '未配置 chatSessionsFile：会话映射未知',
    });
    const delivery = llmOk ? 'full' : 'plain-body-only';
    if (delivery === 'plain-body-only') {
        blocked.push('宿主模型流不可用，普通生成被阻塞；命令与本地存储仍可用');
    }
    return {
        hostVersion: readHostVersion(root),
        nodeVersion: process.version,
        capabilities,
        blocked,
        degraded,
        delivery,
    };
}
function readHostVersion(ctx) {
    for (const key of ['host', 'app', 'runtime']) {
        const value = hostService(ctx, key);
        if (value !== null && typeof value === 'object') {
            const version = value['version'];
            if (typeof version === 'string')
                return version;
        }
    }
    return null;
}
/** doctor 用：把报告压成几行文本。 */
export function describeCompatibility(report) {
    const lines = [
        `宿主版本：${report.hostVersion ?? '未知'} · Node ${report.nodeVersion} · 交付档位：${report.delivery}`,
        ...report.capabilities.map(c => `${c.available ? '✔' : '✘'} ${c.id} (${c.level})：${c.detail}`),
    ];
    if (report.degraded.length > 0)
        lines.push('降级：' + report.degraded.join('；'));
    if (report.blocked.length > 0)
        lines.push('阻塞：' + report.blocked.join('；'));
    return lines.join('\n');
}
//# sourceMappingURL=compatibility.js.map