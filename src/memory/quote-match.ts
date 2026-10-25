/** Return the original source span, allowing typography/spacing differences only. */
export function matchSourceQuote(source: string, quote: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(quote)) return null
  const exact = source.indexOf(quote)
  if (exact >= 0) return source.slice(exact, exact + quote.length)
  const normalize = (input: string) => {
    let text = ''
    const spans: { start: number; end: number }[] = []
    for (let start = 0; start < input.length;) {
      const char = String.fromCodePoint(input.codePointAt(start)!)
      const end = start + char.length
      let normalized = char.normalize('NFKC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      if (/\s/u.test(char)) {
        // Do not merge separate English words or numbers into a different value.
        const before = input.slice(0, start).trimEnd().at(-1) ?? ''
        const after = input.slice(end).trimStart()[0] ?? ''
        normalized = /[a-zA-Z0-9]/.test(before) && /[a-zA-Z0-9]/.test(after) ? ' ' : ''
        if (text.endsWith(' ')) normalized = ''
      }
      text += normalized
      for (let i = 0; i < normalized.length; i++) spans.push({ start, end })
      start = end
    }
    return { text, spans }
  }
  const candidate = normalize(quote.trim()).text
  if (!candidate) return null
  const original = normalize(source)
  const index = original.text.indexOf(candidate)
  if (index < 0) return null
  return source.slice(original.spans[index]!.start, original.spans[index + candidate.length - 1]!.end)
}
