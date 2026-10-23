/**
 * 上下文预算（任务书 §12.1、§12.2、§12.5）。
 *
 * 两条硬规矩：
 *   1. 在**模型调用前**测量最终序列，不是只算新增的 memory block。
 *   2. 超预算时按固定顺序降级，并记录每一级的实际做法；不能静默丢用户当前材料。
 *
 * tokenizer：优先用宿主提供的计数函数（上下文里注入），否则用保守估算并在报告里
 * 明确标注 estimated。汉字 1 字 ≈ 1 token、拉丁 4 字符 ≈ 1 token 是**下界估计**，
 * 不比 provider 更准，具体误差由 docs/ACCEPTANCE_REPORT.md 记录。
 */

export interface TokenCounter {
  id: string
  /** provider 真实 tokenizer 可用时为 false。 */
  estimated: boolean
  count(text: string): number
}

export const BUDGET = {
  persona: 1000,
  boundaries: 100,
  affectState: 150,
  recentDialogue: 1800,
  memoryAndCheckpoint: 350,
  protocolWrapper: 200,
  slack: 400,
  hardInputLimit: 4000,
} as const

export type BudgetSlice = keyof Omit<typeof BUDGET, 'hardInputLimit' | 'slack'>

export const BUDGET_SLICES: readonly BudgetSlice[] = [
  'persona',
  'boundaries',
  'affectState',
  'recentDialogue',
  'memoryAndCheckpoint',
  'protocolWrapper',
]

/** 字符级保守估算：CJK 逐字，其余 4 字符 1 token；结果永不为负。 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

export const estimatedCounter: TokenCounter = {
  id: 'estimate-cjk-v1',
  estimated: true,
  count: estimateTokens,
}

export interface SliceUsage {
  slice: BudgetSlice
  tokens: number
  budget: number
}

export interface BudgetReport {
  total: number
  hardLimit: number
  ok: boolean
  slices: SliceUsage[]
  overBy: number
  /** 已执行的降级步骤，按发生顺序。 */
  degradations: DegradationStep[]
  tokenizerId: string
  estimated: boolean
}

export interface DegradationStep {
  stage: 'dropped-retrieval' | 'trimmed-dialogue' | 'updated-checkpoint' | 'host-compaction' | 'given-up'
  freedTokens: number
  detail?: string
}

/** 待测量的一段输入。 */
export interface ContextSegments {
  persona: string
  boundaries: string
  affectState: string
  recentDialogue: readonly { id: string; text: string; role?: string }[]
  memory: string
  checkpoint: string
  protocolWrapper: string
}

export interface MeasureInput {
  segments: ContextSegments
  counter?: TokenCounter
  userText?: string
  hardInputLimit?: number
  /** 超限时可调用的宿主压缩实现；返回压缩后文本或 null 表示不可用。 */
  hostCompact?: (() => { persona?: string; recentDialogueText?: string } | null) | undefined
}

export interface MeasureResult {
  report: BudgetReport
  /** 实际送进模型的各段文本（可能已被裁剪）。 */
  final: {
    persona: string
    boundaries: string
    affectState: string
    dialogue: string
    memory: string
    checkpoint: string
    protocolWrapper: string
    /** 拼好的完整输入，供调用方再次自检。 */
    fullText: string
  }
  /** 因预算被删掉的检索条目 id。 */
  droppedMemoryTokens: number
  droppedDialogueIds: string[]
  checkpointUpdated: boolean
}

/**
 * 组装 + 计量 + 降级。
 *
 * 降级顺序固定（§12.2）：
 *   删除重复或无关检索项 → 减少较旧的最近对话 → 更新当前话题检查点
 *   → 调用已验证的宿主压缩 → 重新计量
 * 全部用尽仍超限：给出 overBy 并标记 given-up，由调用方决定显式大输入处理。
 */
export function measureAndFit(input: MeasureInput): MeasureResult {
  const counter = input.counter ?? estimatedCounter
  const hardLimit = input.hardInputLimit ?? BUDGET.hardInputLimit
  const degradations: DegradationStep[] = []

  let persona = input.segments.persona
  let memory = input.segments.memory
  let checkpoint = input.segments.checkpoint
  const dialogue = [...input.segments.recentDialogue]
  let droppedMemoryTokens = 0
  const droppedDialogueIds: string[] = []
  let checkpointUpdated = false

  const build = (): { usage: SliceUsage[]; total: number; fullText: string; dialogueText: string } => {
    const dialogueText = dialogue.map((item) => `${labelFor(item.role)}${item.text}`).join('\n')
    const slices: SliceUsage[] = [
      { slice: 'persona', tokens: counter.count(persona), budget: BUDGET.persona },
      { slice: 'boundaries', tokens: counter.count(input.segments.boundaries), budget: BUDGET.boundaries },
      { slice: 'affectState', tokens: counter.count(input.segments.affectState), budget: BUDGET.affectState },
      { slice: 'recentDialogue', tokens: counter.count(dialogueText), budget: BUDGET.recentDialogue },
      { slice: 'memoryAndCheckpoint', tokens: counter.count(memory) + counter.count(checkpoint), budget: BUDGET.memoryAndCheckpoint },
      { slice: 'protocolWrapper', tokens: counter.count(input.segments.protocolWrapper), budget: BUDGET.protocolWrapper },
    ]
    const fullText = [
      persona,
      input.segments.boundaries,
      input.segments.affectState,
      dialogueText,
      memory,
      checkpoint,
      input.segments.protocolWrapper,
    ]
      .filter((part) => part !== '')
      .join('\n\n')
    // Count the exact strings sent as system/user messages, including separators and framing.
    const userTokens = counter.count(input.userText ?? '')
    slices[3]!.tokens += userTokens
    const total = counter.count(fullText) + userTokens + 12
    return { usage: slices, total, fullText, dialogueText }
  }

  let state = build()

  // ① 删除检索项（保留 checkpoint：它是主题连续性，比单条记忆更重要）。
  if (state.total > hardLimit && memory !== '') {
    const before = counter.count(memory)
    memory = ''
    droppedMemoryTokens = before
    const after = build()
    degradations.push({ stage: 'dropped-retrieval', freedTokens: state.total - after.total })
    state = after
  }

  // ② 从最旧的一端裁剪最近对话，但保留最后一条（当前用户消息）。
  while (state.total > hardLimit && dialogue.length > 0) {
    const before = state.total
    const removed = dialogue.shift()
    if (removed !== undefined) droppedDialogueIds.push(removed.id)
    state = build()
    degradations.push({
      stage: 'trimmed-dialogue',
      freedTokens: before - state.total,
      detail: removed === undefined ? undefined : `drop:${removed.id}`,
    })
  }

  // ③ 更新检查点：压缩成一句话（保留主题与未完成约定，丢细节）。
  if (state.total > hardLimit && checkpoint !== '') {
    const before = state.total
    checkpoint = compactCheckpoint(checkpoint)
    checkpointUpdated = true
    state = build()
    degradations.push({ stage: 'updated-checkpoint', freedTokens: before - state.total })
  }

  // ④ 调用宿主压缩（只在确实还有压缩能力时）。
  if (state.total > hardLimit && input.hostCompact !== undefined) {
    const before = state.total
    let compacted: { persona?: string; recentDialogueText?: string } | null = null
    try {
      compacted = input.hostCompact()
    } catch {
      compacted = null
    }
    if (compacted !== null) {
      if (typeof compacted.persona === 'string' && compacted.persona !== '') persona = compacted.persona
      if (typeof compacted.recentDialogueText === 'string') {
        dialogue.length = 0
        dialogue.push({ id: 'host-compacted', text: compacted.recentDialogueText, role: 'internal' })
      }
      state = build()
      degradations.push({ stage: 'host-compaction', freedTokens: before - state.total })
    } else {
      degradations.push({ stage: 'host-compaction', freedTokens: 0, detail: '宿主压缩不可用' })
    }
  }

  const overBy = Math.max(0, state.total - hardLimit)
  if (overBy > 0) {
    degradations.push({ stage: 'given-up', freedTokens: 0, detail: `仍超出 ${overBy} token` })
  }

  return {
    report: {
      total: state.total,
      hardLimit,
      ok: overBy === 0,
      slices: state.usage,
      overBy,
      degradations,
      tokenizerId: counter.id,
      estimated: counter.estimated,
    },
    final: {
      persona,
      boundaries: input.segments.boundaries,
      affectState: input.segments.affectState,
      dialogue: state.dialogueText,
      memory,
      checkpoint,
      protocolWrapper: input.segments.protocolWrapper,
      fullText: state.fullText,
    },
    droppedMemoryTokens,
    droppedDialogueIds,
    checkpointUpdated,
  }
}

function labelFor(role: string | undefined): string {
  if (role === 'user') return '用户：'
  if (role === 'assistant') return '我：'
  return ''
}

/**
 * 检查点压缩：只保留「当前主题 / 未完成约定 / 下一步」三类行。
 * 这是确定性的文本处理，不调用模型——预算降级不能引入新的网络等待。
 */
export function compactCheckpoint(checkpoint: string): string {
  const lines = checkpoint.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const keep = lines.filter((line) => /^(当前主题|未完成|下一步|待办|约定)/.test(line))
  const chosen = keep.length > 0 ? keep : lines.slice(0, 2)
  return chosen.map((line) => (line.length > 60 ? `${line.slice(0, 60)}…` : line)).join('\n')
}

/** §12.5 token 账本的一行记录；字段允许 unknown，绝不把未知填 0。 */
export interface TokenLedgerEntry {
  turnId: string
  phase: 'foreground' | 'background' | 'proactive'
  provider: string
  model: string
  inputTokens: number | 'unknown'
  outputTokens: number | 'unknown'
  cacheHitTokens: number | 'unknown'
  cacheMissTokens: number | 'unknown'
  reasoningTokens: number | 'unknown'
  /** 各类内容的估计占比（0..1），仅在被测量时填写。 */
  composition?: {
    fixedPrompt?: number
    dynamicState?: number
    retrieval?: number
    visibleBody?: number
    internalTags?: number
  }
  retry: number
  atMs: number
  pricedAt?: string
  estimatedCost?: number | 'unknown'
}

export class TokenLedger {
  private readonly entries: TokenLedgerEntry[] = []

  record(entry: TokenLedgerEntry): void {
    this.entries.push(entry)
    // 保留最近 2000 条，避免长跑内存无界。
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000)
  }

  all(): readonly TokenLedgerEntry[] {
    return this.entries
  }

  summary(): {
    foreground: TokenTotals
    background: TokenTotals
    proactive: TokenTotals
    unknownCount: number
  } {
    const empty = (): TokenTotals => ({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      reasoningTokens: 0,
    })
    const totals = { foreground: empty(), background: empty(), proactive: empty() }
    let unknownCount = 0
    for (const entry of this.entries) {
      const bucket = totals[entry.phase]
      bucket.calls += 1
      for (const key of ['inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens'] as const) {
        const value = entry[key]
        if (value === 'unknown') unknownCount += 1
        else bucket[key] += value
      }
    }
    return { ...totals, unknownCount }
  }
}

export interface TokenTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  reasoningTokens: number
}
