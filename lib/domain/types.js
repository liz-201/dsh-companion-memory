/**
 * 自建领域类型（任务书 §4）。
 *
 * 这里是**本插件自己的**接口，不是 DSH 原生 API。与宿主交互的边界在
 * adapters/ 下，宿主类型通过 unknown → 收窄完成，不用 any 敷衍。
 */
export const systemClock = {
    now: () => Date.now(),
};
/** 固定基线时钟：回放与单测用它，禁止 reducer 隐式读 Date.now()。 */
export function fixedClock(startMs, stepMs = 0) {
    let t = startMs;
    return {
        now() {
            const value = t;
            t += stepMs;
            return value;
        },
    };
}
//# sourceMappingURL=types.js.map