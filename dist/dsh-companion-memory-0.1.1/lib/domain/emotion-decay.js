/**
 * 时间衰减（任务书 §8.3）。
 *
 * x(now) = baseline + (x(last) - baseline) * 2^(-(now-last)/halfLife)
 *
 * 只做纯计算：读取时按需衰减，收到真实事件后再持久提交。没有「每分钟 tick
 * 写一条状态事件」的路径，也没有隐式 Date.now()——时间一律由参数传入。
 */
export const MOOD_BASELINE = {
    anger: 0,
    hurt: 0,
    joy: 0.1,
    tension: 0.05,
    expressiveness: 0.4,
};
export const MOOD_HALF_LIFE_MINUTES = {
    anger: 90,
    hurt: 360,
    joy: 120,
    tension: 60,
    expressiveness: 120,
};
/**
 * trust / respect / affection 没有人联系时**不自动降低也不自动恢复**；
 * grievance 只由 episode 解决、修复事件与非常缓慢的显著性衰减改变。
 * 这里给 grievance 一个很长的半衰期基线，且默认不启用（见 decayGrievance）。
 */
export const GRIEVANCE_HALF_LIFE_MINUTES = 60 * 24 * 30;
export function decayValue(value, baseline, halfLifeMinutes, elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0)
        return value;
    if (!Number.isFinite(halfLifeMinutes) || halfLifeMinutes <= 0)
        return value;
    const elapsedMinutes = elapsedMs / 60_000;
    const factor = Math.pow(2, -elapsedMinutes / halfLifeMinutes);
    return baseline + (value - baseline) * factor;
}
export function decayMood(mood, elapsedMs, options = {}) {
    const halfLife = { ...MOOD_HALF_LIFE_MINUTES, ...options.halfLifeMinutes };
    return {
        anger: decayValue(mood.anger, MOOD_BASELINE.anger, halfLife.anger, elapsedMs),
        hurt: decayValue(mood.hurt, MOOD_BASELINE.hurt, halfLife.hurt, elapsedMs),
        joy: decayValue(mood.joy, MOOD_BASELINE.joy, halfLife.joy, elapsedMs),
        tension: decayValue(mood.tension, MOOD_BASELINE.tension, halfLife.tension, elapsedMs),
        expressiveness: decayValue(mood.expressiveness, MOOD_BASELINE.expressiveness, halfLife.expressiveness, elapsedMs),
    };
}
export function decayRelationship(relationship, elapsedMs, options = {}) {
    const next = {
        affection: relationship.affection,
        trust: relationship.trust,
        respect: relationship.respect,
        familiarity: relationship.familiarity,
        grievance: relationship.grievance,
    };
    if (options.decayGrievance === true) {
        const halfLife = options.grievanceHalfLifeMinutes ?? GRIEVANCE_HALF_LIFE_MINUTES;
        next.grievance = decayValue(relationship.grievance, 0, halfLife, elapsedMs);
    }
    return next;
}
export const ANGER_LEVELS = [
    { enter: 0.65, exit: 0.55, label: '怒气很重' },
    { enter: 0.35, exit: 0.25, label: '仍在生气' },
    { enter: 0.15, exit: 0.08, label: '有点不爽' },
];
export const HURT_LEVELS = [
    { enter: 0.6, exit: 0.5, label: '很委屈' },
    { enter: 0.3, exit: 0.2, label: '有些委屈' },
];
export const TENSION_LEVELS = [
    { enter: 0.6, exit: 0.5, label: '关系紧张' },
    { enter: 0.3, exit: 0.2, label: '气氛有点僵' },
];
export const AFFECTION_LEVELS = [
    { enter: 0.65, exit: 0.55, label: '很亲近' },
    { enter: 0.35, exit: 0.25, label: '比较亲近' },
    { enter: 0.1, exit: 0.05, label: '普通偏熟' },
];
export const TRUST_LEVELS = [
    { enter: 0.75, exit: 0.65, label: '信任' },
    { enter: 0.45, exit: 0.35, label: '基本信任' },
    { enter: 0.2, exit: 0.15, label: '不太放心' },
];
/**
 * 稳定地选中一个等级：只有超过 enter 才升档，低于 exit 才降档；两者之间
 * 保持 previousLabel。previousLabel 为 undefined 时按 enter 判定。
 */
export function pickLevel(value, levels, previousLabel) {
    const previousIndex = previousLabel === undefined
        ? -1
        : levels.findIndex((level) => level.label === previousLabel);
    // 保持或升档：没有越过当前等级的 exit 就留在原档，但仍允许更高档的 enter。
    if (previousIndex >= 0 && value >= levels[previousIndex].exit) {
        for (let index = previousIndex - 1; index >= 0; index -= 1) {
            if (value >= levels[index].enter)
                return levels[index].label;
        }
        return levels[previousIndex].label;
    }
    // 首档或降档：从高到低找第一个越过 enter 的等级。
    for (let index = 0; index < levels.length; index += 1) {
        if (value >= levels[index].enter)
            return levels[index].label;
    }
    return undefined;
}
export function clamp(value, min = 0, max = 1) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, value));
}
export function round3(value) {
    return Math.round(value * 1000) / 1000;
}
//# sourceMappingURL=emotion-decay.js.map