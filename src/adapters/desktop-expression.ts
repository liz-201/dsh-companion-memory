type Chunk = Record<string, unknown>
/** Preserve nontext protocol blocks and block indices. No text is visible before validation. */
export async function* guardDesktopStream(source: AsyncIterable<unknown>, guard: (text: string) => Promise<string | null>, signal?: AbortSignal): AsyncGenerator<unknown> {
  let chunks: Chunk[] = [], length = 0, changed = false
  const flush = async (): Promise<Chunk[]> => {
    const groups = new Map<unknown, string>()
    for (const chunk of chunks) if (chunk['type'] === 'text-delta') groups.set(chunk['index'], (groups.get(chunk['index']) ?? '') + String(chunk['text'] ?? ''))
    const rendered = new Map<unknown, string>()
    for (const [index, text] of groups) {
      const result = await guard(text)
      signal?.throwIfAborted()
      if (result === null) throw new Error('companion expression blocked: generate a new response')
      if (result !== text) changed = true
      rendered.set(index, result)
    }
    const emitted = new Set<unknown>()
    const output: Chunk[] = []
    for (const chunk of chunks) {
      if (chunk['type'] !== 'text-delta') {
        if (changed && chunk['type'] === 'finish') { const clean = { ...chunk }; delete clean['replayState']; output.push(clean) }
        else output.push(chunk)
      }
      else if (!emitted.has(chunk['index'])) { output.push({ ...chunk, text: rendered.get(chunk['index']) ?? '' }); emitted.add(chunk['index']) }
    }
    chunks = []; length = 0
    return output
  }
  for await (const raw of source) {
    signal?.throwIfAborted()
    if (!raw || typeof raw !== 'object') throw new Error('Invalid Desktop stream chunk')
    const chunk = raw as Chunk
    // Tool/reasoning boundaries flush the preceding text; tool arguments are never rewritten.
    if (['tool-call-delta', 'reasoning-delta'].includes(String(chunk['type']))) {
      for (const item of await flush()) yield item
      yield chunk
      continue
    }
    if (chunk['type'] === 'finish' && ['aborted', 'error'].includes(String((chunk['reason'] as Chunk | undefined)?.['kind']))) { chunks = []; yield chunk; return }
    chunks.push(chunk)
    if (chunk['type'] === 'text-delta') length += Buffer.byteLength(String(chunk['text'] ?? ''), 'utf8')
    if (length > 32768) throw new Error('Desktop expression buffer exceeds 32 KiB; use a bounded task response')
  }
  for (const chunk of await flush()) yield chunk
}
