/** Cordis optional services must be discovered through get(), not proxy properties. */
export function hostService(ctx, name) {
    try {
        const get = ctx['get'];
        return typeof get === 'function' ? get.call(ctx, name) : ctx[name];
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=host-service.js.map