import type { EvtPayload } from './output-protocol.js'

/** Tagged reasoning is never visible history. An unclosed tag consumes the tail. */
export function visibleText(text: string): string {
  let output = '', cursor = 0, depth = 0
  for (const tag of text.matchAll(/<(\/?)(?:thinking|think|reasoning)\b[^>]*>/gi)) {
    if (depth === 0) output += text.slice(cursor, tag.index)
    if (tag[1]) {
      if (depth === 0) output = '' // Orphan close: preceding text may be reasoning.
      else depth -= 1
    } else depth += 1
    cursor = tag.index + tag[0].length
  }
  if (depth === 0) output += text.slice(cursor)
  return output.trim()
}

/** Conservative fallback: no facts, no tasks, and no inference from quoted/technical text. */
export function localObservation(text: string): EvtPayload {
  const empty: EvtPayload = { v: 1, e: [] }
  if (text.length > 160 || /引用|台词|比如|例如|假如|他说|她说|别人说|代码|报错|插件|```|[“”「」『』"]/.test(text)) return empty
  const kind = /^(?:对不起|抱歉|刚才是我不对)[，。！!\s]*$/.test(text) ? 'apology'
    : /^(?:谢谢你|你真棒|你做得很好|辛苦你了)[，。！!\s]*$/.test(text) ? 'appreciation'
    : /^(?:没关系|我没有怪你|我不会怪你)[，。！!\s]*$/.test(text) ? 'reassurance'
    : /^(?:你是笨蛋|你真蠢|你就是个废物)[，。！!\s]*$/.test(text) ? 'insult' : null
  if (kind) empty.e.push({ k: kind, to: 'self', i: kind === 'apology' ? 'repair' : kind === 'insult' ? 'hostile' : 'neutral', s: 1, c: 0.6 })
  return empty
}
