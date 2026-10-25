import type { HostContext } from './dsh-adapter.js'

/** Cordis optional services must be discovered through get(), not proxy properties. */
export function hostService(ctx: HostContext, name: string): unknown {
  try {
    const get = ctx['get']
    return typeof get === 'function' ? get.call(ctx, name) : ctx[name]
  } catch { return undefined }
}
