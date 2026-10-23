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

export type CapabilityId =
  | 'systemPrompt'
  | 'tools'
  | 'agents'
  | 'sessions'
  | 'commands'
  | 'llm'
  | 'systemPromptEvent'
  | 'agentLoopEvent'
  | 'webServer'
  | 'onebotHttp'
  | 'chatSessionsFile'

export interface Capability {
  id: CapabilityId
  available: boolean
  /** 可用于实现的能力等级；缺省 null 表示不可用。 */
  level: 'full' | 'partial' | 'none'
  detail: string
}

export interface CompatibilityReport {
  hostVersion: string | null
  nodeVersion: string
  capabilities: Capability[]
  /** 无法实现、必须向用户如实说明的功能。 */
  blocked: string[]
  /** 可以跑但质量下降的功能。 */
  degraded: string[]
  /** 与任务书 §13 对照后的结论：实现的是哪一档交付。 */
  delivery: 'full' | 'plain-body-only'
}

interface LooseContext {
  [key: string]: unknown
}

function has(ctx: LooseContext, key: string): boolean {
  try {
    return ctx[key] !== undefined && ctx[key] !== null
  } catch {
    return false
  }
}

function callable(value: unknown, method: string): boolean {
  if (value === null || value === undefined) return false
  try {
    return typeof (value as Record<string, unknown>)[method] === 'function'
  } catch {
    return false
  }
}

/** 只读探测宿主能力；任何异常都当成「不可用」，不让装配因为探测失败而崩。 */
export function probeCapabilities(ctx: unknown, options: { onebotHttpBase?: string; chatSessionsFile?: string } = {}): CompatibilityReport {
  const root = (ctx ?? {}) as LooseContext
  const capabilities: Capability[] = []
  const blocked: string[] = []
  const degraded: string[] = []

  const systemPrompt = root['systemPrompt']
  const systemPromptOk = callable(systemPrompt, 'section') || callable(systemPrompt, 'variable')
  capabilities.push({
    id: 'systemPrompt',
    available: systemPromptOk,
    level: systemPromptOk ? 'full' : 'none',
    detail: systemPromptOk ? 'ctx.systemPrompt 可注册段落/变量' : '没有 systemPrompt 服务：人格段落无法注入，只能把提示词拼进消息体',
  })
  if (!systemPromptOk) degraded.push('系统提示注入不可用：人格与协议改走消息前缀（会占用正文预算）')

  const tools = root['tools']
  const toolsOk = callable(tools, 'register')
  capabilities.push({
    id: 'tools',
    available: toolsOk,
    level: toolsOk ? 'full' : 'none',
    detail: toolsOk ? 'ctx.tools.register 可用' : '没有 tools 服务：fish_* 工具不注册，命令走 QQ 桥',
  })

  const sessions = root['sessions']
  const agentsOk = has(root, 'agents')
  capabilities.push({
    id: 'agents',
    available: agentsOk,
    level: agentsOk ? 'full' : 'none',
    detail: agentsOk ? 'ctx.agents 存在，可按 Agent 作用域安装适配' : '没有 agents 服务：只能全局作用域安装，需要人工确认不污染工程 Agent',
  })
  if (!agentsOk) degraded.push('无 agents 服务：人格作用域无法按 Agent 隔离（§13.1 的隔离要求降级）')

  const sessionsOk = sessions !== undefined && sessions !== null
  capabilities.push({
    id: 'sessions',
    available: sessionsOk,
    level: sessionsOk ? 'partial' : 'none',
    detail: sessionsOk ? 'ctx.sessions 存在（历史投影/会话读写能力需逐个方法确认）' : '没有 sessions 服务：本地消息表是唯一历史来源',
  })

  const commands = root['commands']
  const commandsOk = callable(commands, 'register')
  capabilities.push({
    id: 'commands',
    available: commandsOk,
    level: commandsOk ? 'full' : 'none',
    detail: commandsOk ? 'ctx.commands.register 可用，可注册 /fish 子命令' : '没有 commands 服务：/fish 只能由 QQ 桥的斜杠路由分发',
  })

  const llm = root['llm']
  const llmOk = has(root, 'llm') && callable(llm, 'listModels')
  capabilities.push({
    id: 'llm',
    available: llmOk,
    level: llmOk ? 'full' : 'none',
    detail: llmOk ? 'ctx.llm 可枚举 provider/model（不硬编码模型名）' : '没有 llm 目录：模型名必须由宿主注入',
  })

  const onEvent = callable(root, 'on')
  capabilities.push({
    id: 'systemPromptEvent',
    available: onEvent,
    level: onEvent ? 'full' : 'none',
    detail: onEvent ? "ctx.on('system-prompt/assemble') 可挂装配钩子" : '无法订阅装配事件：只能静态注册段落',
  })
  capabilities.push({
    id: 'agentLoopEvent',
    available: onEvent,
    level: onEvent ? 'partial' : 'none',
    detail: onEvent ? '可用 ctx.on 订阅 agent 事件（具体事件名按宿主版本核对）' : '未订阅 agent 事件：回合数据由 QQ 桥提供',
  })

  const webServer = root['webServer']
  const webOk = callable(webServer, 'register')
  capabilities.push({
    id: 'webServer',
    available: webOk,
    level: webOk ? 'partial' : 'none',
    detail: webOk ? 'webServer.register 可用（本地状态页）' : '没有 webServer：不提供 HTTP 状态页',
  })

  const onebotOk = typeof options.onebotHttpBase === 'string' && /^https?:\/\//.test(options.onebotHttpBase)
  capabilities.push({
    id: 'onebotHttp',
    available: onebotOk,
    level: onebotOk ? 'partial' : 'none',
    detail: onebotOk ? '配置了 OneBot HTTP 端点：主动消息可直发' : '未配置 OneBot HTTP 端点：主动消息只写 outbox，等桥接层代发',
  })
  if (!onebotOk) degraded.push('无 OneBot HTTP 端点：主动消息停留在 outbox（pending），不会宣称已送达')

  const fileOk = typeof options.chatSessionsFile === 'string' && options.chatSessionsFile.length > 0
  capabilities.push({
    id: 'chatSessionsFile',
    available: fileOk,
    level: fileOk ? 'partial' : 'none',
    detail: fileOk ? '可读 dsh-onebot-qq 的 chat→session 映射' : '未配置 chatSessionsFile：会话映射未知',
  })

  const delivery: CompatibilityReport['delivery'] = systemPromptOk && toolsOk ? 'full' : 'plain-body-only'
  if (delivery === 'plain-body-only') {
    blocked.push('early send（正文提前发送）与尾部事件应用未满足完整档：当前交付为纯正文路径 + 后台提取（§13.3）')
  }

  return {
    hostVersion: readHostVersion(root),
    nodeVersion: process.version,
    capabilities,
    blocked,
    degraded,
    delivery,
  }
}

function readHostVersion(ctx: LooseContext): string | null {
  for (const key of ['host', 'app', 'runtime']) {
    const value = ctx[key]
    if (value !== null && typeof value === 'object') {
      const version = (value as LooseContext)['version']
      if (typeof version === 'string') return version
    }
  }
  return null
}

/** doctor 用：把报告压成几行文本。 */
export function describeCompatibility(report: CompatibilityReport): string {
  const lines = [
    `宿主版本：${report.hostVersion ?? '未知'} · Node ${report.nodeVersion} · 交付档位：${report.delivery}`,
    ...report.capabilities.map(c => `${c.available ? '✔' : '✘'} ${c.id} (${c.level})：${c.detail}`),
  ]
  if (report.degraded.length > 0) lines.push('降级：' + report.degraded.join('；'))
  if (report.blocked.length > 0) lines.push('阻塞：' + report.blocked.join('；'))
  return lines.join('\n')
}
