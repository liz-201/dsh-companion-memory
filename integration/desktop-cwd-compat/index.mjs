/** Bridge legacy {{cwd}} prompts to Desktop's current working-directory service. */
export const name = 'dsh-desktop-cwd-compat'
export const inject = ['systemPrompt']

function effectiveDirectory(ctx, context) {
  const session = context?.agent?.session ?? context?.session
  if (!session) return 'unavailable (no active session)'
  try {
    const service = context?.agent?.ctx?.get?.('workingDirectory') ?? ctx.get?.('workingDirectory')
    const current = service?.get?.(session)
    if (typeof current === 'string' && current.trim()) return current
  } catch { /* A host without this service can still use the session's declared directory. */ }
  const declared = session.header?.cwd
  return typeof declared === 'string' && declared.trim() ? declared : 'unavailable (no working directory supplied by the session)'
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = typeof next === 'function' ? await next() : assembly
    if (!assembled || typeof assembled !== 'object') return assembled
    // Keep host/preset values. Fill missing/undefined legacy variables without
    // registering a global provider that could collide with another plugin.
    if (typeof assembled.variables?.cwd === 'string' && assembled.variables.cwd.trim()) return assembled
    return { ...assembled, variables: { ...assembled.variables, cwd: effectiveDirectory(ctx, context) } }
  }, { global: true })
}
