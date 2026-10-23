import { findRootObjectEnd } from './output-protocol.js'

/**
 * 流式协议解析状态机（任务书 §7.3、§27.4）。
 *
 * 状态：WAIT_SAY → IN_SAY → AFTER_SAY → IN_EVT → DONE / INVALID。
 *
 * 设计要求（逐条对应测试）：
 *   · 任意 chunk 切分（逐字节、逐字符、标记跨块）都能正确识别；
 *   · Unicode 代理对被切开时不丢字符；
 *   · 正文里出现协议字样（如用户让它解释 `</say>`）由 §7.2 转义规则规避，
 *     但解析器仍要能识别**未转义**的第二个 `<say>` 并判为异常；
 *   · evt 为空、畸形、重复、超长、缺闭合都要有确定结论，绝不把半截 JSON 当有效记录；
 *   · stream cancel / 非流式整包返回走同一个 finish()。
 */

export type ParserState = 'WAIT_SAY' | 'IN_SAY' | 'AFTER_SAY' | 'IN_EVT' | 'DONE' | 'INVALID'

export type ParserProblem =
  | 'text-before-say'
  | 'missing-say'
  | 'duplicate-say'
  | 'duplicate-evt'
  | 'evt-oversize'
  | 'evt-unclosed'
  | 'evt-empty'
  | 'evt-malformed'
  | 'say-unclosed'
  | 'trailing-text'

export interface ParserOptions {
  /** evt 硬上限（字节）。默认 2048（§7.1「192 token / 2KB」）。 */
  evtMaxBytes?: number
  /** 正文上限，防止模型失控时无限缓冲。默认 20000 字符。 */
  sayMaxChars?: number
  /** 允许 AFTER_SAY 之后出现无关尾文而不判 INVALID（只记录问题）。默认 true。 */
  tolerateTrailing?: boolean
}

export interface ParseEvent {
  type: 'say-open' | 'say-progress' | 'say-closed' | 'evt-open' | 'evt-closed' | 'done' | 'problem'
  /** say-closed 时是解码（XML 反转义）一次后的正文。 */
  text?: string
  /** evt-closed 时是原始 JSON 文本（未解析）。 */
  raw?: string
  problem?: ParserProblem
  detail?: string
}

export interface ParserResult {
  state: ParserState
  say: string | null
  evtRaw: string | null
  problems: ParserProblem[]
  /** 正文里是否出现过第二个 `<say>`（用于判定模型在模仿协议）。 */
  duplicateSay: boolean
  duplicateEvt: boolean
  /** 未闭合时已收到的部分，供诊断（不得显示给用户）。 */
  partialEvt: string | null
  /** 模型没按协议输出时的原始文本（§7.5 纯文本回退的唯一来源）。 */
  plainText: string | null
}

const SAY_OPEN = '<say>'
const SAY_CLOSE = '</say>'
const EVT_OPEN = '<evt>'
const EVT_CLOSE = '</evt>'

/** 只保留可能是某个标记前缀的最短后缀（避免把 `<sa` 当正文输出又避免丢块）。 */
function pendingSuffix(buffer: string, markers: readonly string[]): string {
  let best = ''
  for (const marker of markers) {
    const max = Math.min(marker.length - 1, buffer.length)
    for (let len = max; len > 0; len -= 1) {
      const suffix = buffer.slice(buffer.length - len)
      if (marker.startsWith(suffix) && len > best.length) best = suffix
    }
  }
  return best
}

/** §7.2：只解码一次，且只认 XML 文本实体；不做 HTML 富文本或 DOM 解析。 */
export function decodeSayText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 编码时先替换 & 再替换 <，保证解码一次可逆。 */
export function encodeSayText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export class StreamParser {
  private readonly evtMaxBytes: number
  private readonly sayMaxChars: number
  private readonly tolerateTrailing: boolean

  private state: ParserState = 'WAIT_SAY'
  private buffer = ''
  private pendingHighSurrogate = ''
  private sayRaw = ''
  private sayText: string | null = null
  private evtRaw: string | null = null
  private evtBuffer = ''
  private evtBytes = 0
  private readonly problems: ParserProblem[] = []
  private duplicateSay = false
  private duplicateEvt = false
  private partialEvt: string | null = null
  private plainText: string | null = null
  private finished = false
  private cancelled = false
  private closedSayEmitted = false

  constructor(options: ParserOptions = {}) {
    this.evtMaxBytes = options.evtMaxBytes ?? 2048
    this.sayMaxChars = options.sayMaxChars ?? 20000
    this.tolerateTrailing = options.tolerateTrailing ?? true
  }

  get currentState(): ParserState {
    return this.state
  }

  /** 喂入一个流式分片；返回本片产生的语义事件（可为空数组）。 */
  feed(chunk: string): ParseEvent[] {
    const events: ParseEvent[] = []
    if (this.cancelled) return events
    let text = chunk
    // 处理被切开的代理对：上一片留下的高位 + 本片低位。
    if (this.pendingHighSurrogate !== '') {
      text = this.pendingHighSurrogate + text
      this.pendingHighSurrogate = ''
    }
    const last = text.charCodeAt(text.length - 1)
    if (text !== '' && last >= 0xd800 && last <= 0xdbff) {
      this.pendingHighSurrogate = text.slice(-1)
      text = text.slice(0, -1)
    }
    if (text === '') return events
    this.buffer += text
    this.drain(events)
    return events
  }

  /**
   * 流结束（正常结束或 stream cancel 后仍调用一次）。
   * 返回最终结果；未闭合的 say 会带上已收到的正文（由调用方决定是否发送）。
   */
  finish(): { events: ParseEvent[]; result: ParserResult } {
    const events: ParseEvent[] = []
    if (!this.cancelled) {
      if (this.pendingHighSurrogate !== '') {
        this.buffer += this.pendingHighSurrogate
        this.pendingHighSurrogate = ''
      }
      this.drain(events)
      this.closeOut(events)
    }
    this.finished = true
    return { events, result: this.result() }
  }

  /** 上游取消：保留已收到的正文，不再尝试解析尾部标记。 */
  cancel(): void {
    this.cancelled = true
    this.closeOut([])
  }

  result(): ParserResult {
    return {
      state: this.state,
      say: this.sayText,
      evtRaw: this.evtRaw,
      problems: [...this.problems],
      duplicateSay: this.duplicateSay,
      duplicateEvt: this.duplicateEvt,
      partialEvt: this.partialEvt,
      plainText: this.plainText,
    }
  }

  // ---------- 内部 ----------

  private drain(events: ParseEvent[]): void {
    let guard = 0
    while (guard < 64) {
      guard += 1
      if (!this.step(events)) return
    }
  }

  /** 推进一次状态；返回是否可能还有进展。 */
  private step(events: ParseEvent[]): boolean {
    switch (this.state) {
      case 'WAIT_SAY': {
        const idx = this.buffer.indexOf(SAY_OPEN)
        if (idx < 0) {
          // 整个缓冲恰好是 `<say>` 的前缀（流式分片切在标记中间）：等下一片，
          // 不能当正文判死，否则 `<sa` + `y>` 会被误判成 text-before-say。
          const keep = pendingSuffix(this.buffer, [SAY_OPEN])
          if (keep.length === this.buffer.length) return false
          // 只有空白可以出现在 <say> 之前；其余文本说明模型没按协议输出。
          const trimmed = this.buffer.trim()
          if (trimmed !== '') {
            this.problems.push('text-before-say')
            // 留着原话：调用方按 §7.5 纯文本回退时要用它，不能把用户该看到的话丢掉。
            this.plainText = this.buffer
            this.state = 'INVALID'
            return false
          }
          this.buffer = keep
          return false
        }
        if (this.buffer.slice(0, idx).trim() !== '') {
          this.problems.push('text-before-say')
          this.state = 'INVALID'
          return false
        }
        this.buffer = this.buffer.slice(idx + SAY_OPEN.length)
        this.state = 'IN_SAY'
        events.push({ type: 'say-open' })
        return true
      }
      case 'IN_SAY': {
        const idx = this.buffer.indexOf(SAY_CLOSE)
        if (idx < 0) {
          // 检查是否有第二个 <say>（模型自说自话时会这样）。
          const dup = this.buffer.indexOf(SAY_OPEN)
          if (dup >= 0) this.duplicateSay = true
          this.sayRaw += this.buffer
          if (this.sayRaw.length > this.sayMaxChars) {
            this.sayRaw = this.sayRaw.slice(0, this.sayMaxChars)
            this.problems.push('say-unclosed')
          }
          this.buffer = pendingSuffix(this.sayRaw, [SAY_CLOSE])
          this.sayRaw = this.sayRaw.slice(0, this.sayRaw.length - this.buffer.length)
          events.push({ type: 'say-progress', text: this.sayRaw })
          return false
        }
        this.sayRaw += this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + SAY_CLOSE.length)
        this.sayText = decodeSayText(this.sayRaw)
        this.state = 'AFTER_SAY'
        this.closedSayEmitted = true
        events.push({ type: 'say-closed', text: this.sayText })
        return true
      }
      case 'AFTER_SAY': {
        const trimmedStart = this.buffer.replace(/^\s+/, '')
        this.buffer = trimmedStart
        if (this.buffer === '') return false
        if (this.buffer.startsWith(EVT_OPEN)) {
          this.buffer = this.buffer.slice(EVT_OPEN.length)
          this.state = 'IN_EVT'
          this.evtBuffer = ''
          this.evtBytes = 0
          events.push({ type: 'evt-open' })
          return true
        }
        const sayAgain = this.buffer.indexOf(SAY_OPEN)
        if (sayAgain >= 0) {
          this.duplicateSay = true
          this.problems.push('duplicate-say')
          this.buffer = ''
          return false
        }
        const partial = pendingSuffix(this.buffer, [EVT_OPEN, SAY_OPEN])
        const filled = this.buffer.slice(0, this.buffer.length - partial.length)
        this.buffer = partial
        if (filled.trim() !== '') {
          this.problems.push('trailing-text')
          if (!this.tolerateTrailing) {
            this.state = 'INVALID'
            return false
          }
        }
        return false
      }
      case 'IN_EVT': {
        this.evtBuffer += this.buffer
        this.buffer = ''
        const rootEnd = findRootObjectEnd(this.evtBuffer)
        const json = rootEnd === null ? this.evtBuffer : this.evtBuffer.slice(0, rootEnd)
        this.evtBytes = Buffer.byteLength(json, 'utf8')
        if (this.evtBytes > this.evtMaxBytes) {
          this.partialEvt = this.evtBuffer.slice(0, 512)
          this.problems.push('evt-oversize')
          this.state = 'INVALID'
          this.evtBuffer = ''
          return false
        }
        if (rootEnd === null) return false
        const tail = this.evtBuffer.slice(rootEnd).trimStart()
        if (tail === '' || (tail.length < EVT_CLOSE.length && EVT_CLOSE.startsWith(tail))) return false
        if (!tail.startsWith(EVT_CLOSE)) {
          this.problems.push('evt-malformed')
          this.state = 'INVALID'
          return false
        }
        this.evtRaw = json
        events.push({ type: 'evt-closed', raw: json })
        this.buffer = tail.slice(EVT_CLOSE.length)
        this.evtBuffer = ''
        this.state = 'DONE'
        return true
      }
      case 'DONE': {
        const rest = this.buffer
        this.buffer = ''
        if (rest.trim() !== '') {
          if (rest.includes(EVT_OPEN)) {
            this.duplicateEvt = true
            this.problems.push('duplicate-evt')
          } else if (rest.includes(SAY_OPEN)) {
            this.duplicateSay = true
            this.problems.push('duplicate-say')
          } else {
            this.problems.push('trailing-text')
            if (!this.tolerateTrailing) this.state = 'INVALID'
          }
        }
        return false
      }
      case 'INVALID':
        return false
      default:
        return false
    }
  }

  private closeOut(events: ParseEvent[]): void {
    if (this.state === 'WAIT_SAY') {
      const leftover = this.buffer.trim()
      if (leftover === '') {
        this.problems.push('missing-say')
        this.state = 'INVALID'
      } else {
        // 整段纯文本：没有协议封装。调用方按「纯文本回退」处理。
        this.problems.push('missing-say')
        this.sayText = this.sayText ?? decodeSayText(leftover)
        this.plainText = this.plainText ?? leftover
        this.state = 'INVALID'
      }
      return
    }
    if (this.state === 'IN_SAY') {
      this.sayRaw += this.buffer
      this.buffer = ''
      this.problems.push('say-unclosed')
      this.sayText = decodeSayText(this.sayRaw)
      this.state = 'INVALID'
      if (!this.closedSayEmitted && this.sayText !== '') {
        this.closedSayEmitted = true
        events.push({ type: 'say-closed', text: this.sayText })
      }
      return
    }
    if (this.state === 'IN_EVT') {
      this.partialEvt = this.evtBuffer.slice(0, 512)
      this.problems.push('evt-unclosed')
      this.evtRaw = null
      this.state = 'INVALID'
      return
    }
    if (this.state === 'AFTER_SAY') {
      this.state = 'DONE'
      events.push({ type: 'done' })
      return
    }
    if (this.state === 'DONE') {
      if (!this.finished) events.push({ type: 'done' })
      return
    }
  }
}

/** 一次性解析（非流式返回、测试与回放用）。 */
export function parseComplete(text: string, options: ParserOptions = {}): ParserResult & { events: ParseEvent[] } {
  const parser = new StreamParser(options)
  const events = parser.feed(text)
  const end = parser.finish()
  return { ...end.result, events: [...events, ...end.events] }
}
