/**
 * 观测与计时（任务书 §17.1–§17.5）。
 *
 * 只做「记录 + 汇总」，不做任何决策。计时点按 §17.2 定义：
 *   assembly（装配）→ retrieval（检索）→ queue-wait（排队）→
 *   provider-first-token（首个分片）→ say-close（正文收尾）→ send（送达）
 *
 * 延迟目标（§17.1）：
 *   装配 p95 ≤ 50ms；正文首字 p95 ≤ 1.2s；正文完整 p95 ≤ 3s；发送 p95 ≤ 1s。
 * 这里**不宣称**达标，只负责把实测值算出来给 bench/doctor 报告。
 */
export const PHASES = [
    'assembly',
    'retrieval',
    'queue-wait',
    'provider-first-token',
    'say-close',
    'evt-apply',
    'send',
    'total',
];
/** §17.1 的验收目标；报告里逐项对比，达不到就如实写「未达标」。 */
export const LATENCY_TARGETS_MS = {
    assembly: 50,
    retrieval: 50,
    'queue-wait': 250,
    'provider-first-token': 1200,
    'say-close': 3000,
    'evt-apply': 30,
    send: 1000,
    total: 4000,
};
function percentile(sorted, ratio) {
    if (sorted.length === 0)
        return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index] ?? 0;
}
export class Metrics {
    samples = [];
    counters = new Map();
    degraded = new Set();
    limit;
    repos;
    /** Daily counters survive restarts; timing samples remain a bounded in-memory window. */
    attachStorage(repos) {
        this.repos = repos;
        const prefix = `metrics.daily:${new Date().toISOString().slice(0, 10)}:`;
        for (const row of repos.db.all('SELECT key, value FROM plugin_settings WHERE key LIKE ?', `${prefix}%`)) {
            this.counters.set(row.key.slice(prefix.length), Number(row.value));
        }
    }
    /** cap 防止长跑进程无限增长；超出后丢最旧的样本（计数器不受影响）。 */
    constructor(limit = 5000) {
        this.limit = Math.max(50, limit);
    }
    record(turnId, phase, ms, atMs) {
        if (!Number.isFinite(ms) || ms < 0)
            return;
        this.samples.push({ turnId, phase, ms, atMs });
        if (this.samples.length > this.limit)
            this.samples.splice(0, this.samples.length - this.limit);
    }
    /** 用一对时间戳记录一段耗时；缺任一端就跳过（不把未知当 0）。 */
    span(turnId, phase, startedAtMs, endedAtMs) {
        if (startedAtMs === undefined)
            return;
        this.record(turnId, phase, endedAtMs - startedAtMs, endedAtMs);
    }
    count(name, delta = 1) {
        this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
        if (!this.repos?.db.isOpen)
            return;
        try {
            const now = Date.now(), key = `metrics.daily:${new Date(now).toISOString().slice(0, 10)}:${name}`;
            this.repos.db.run('INSERT INTO plugin_settings (key, value, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS REAL) + ?, updated_at_ms = excluded.updated_at_ms', key, String(delta), now, delta);
        }
        catch {
            this.degraded.add('指标持久化失败');
        }
    }
    /** 降级原因去重记录，doctor 与 /fish status 直接展示。 */
    degrade(reason) {
        this.degraded.add(reason);
        if (this.degraded.size > 100)
            this.degraded.delete(this.degraded.values().next().value);
        if (!this.repos?.db.isOpen)
            return;
        try {
            this.repos.audit({ principalId: null, kind: 'runtime-degraded', entityId: null,
                payload: { reason: reason.slice(0, 1200) }, createdAtMs: Date.now() });
        }
        catch {
            this.degraded.add('诊断审计持久化失败');
        }
    }
    stats() {
        return PHASES.map(phase => {
            const values = this.samples.filter(s => s.phase === phase).map(s => s.ms).sort((a, b) => a - b);
            return {
                phase,
                count: values.length,
                p50: Math.round(percentile(values, 0.5)),
                p95: Math.round(percentile(values, 0.95)),
                max: Math.round(values.length === 0 ? 0 : (values[values.length - 1] ?? 0)),
                targetMs: LATENCY_TARGETS_MS[phase],
                met: values.length > 0 && percentile(values, 0.95) <= LATENCY_TARGETS_MS[phase],
            };
        });
    }
    snapshot() {
        return {
            stats: this.stats(),
            counters: Object.fromEntries(this.counters),
            degraded: [...this.degraded].sort(),
            samplesKept: this.samples.length,
        };
    }
    /** 一行人类可读摘要，供日志与 /fish status。 */
    summary() {
        const stats = this.stats().filter(s => s.count > 0);
        if (stats.length === 0)
            return '暂无计时样本';
        return stats
            .map(s => `${s.phase} p95=${s.p95}ms/${s.targetMs}ms${s.met ? '' : '(未达标)'}`)
            .join(' · ');
    }
    clear() {
        this.samples.length = 0;
    }
}
/**
 * 简单的一次性秒表：调用方 start()，phase() 记录中间点。
 * 不依赖 Date.now 的隐式调用——clock 由参数传入，测试可注入固定时钟。
 */
export class TurnStopwatch {
    turnId;
    metrics;
    nowMs;
    marks = [];
    start;
    constructor(turnId, metrics, nowMs) {
        this.turnId = turnId;
        this.metrics = metrics;
        this.nowMs = nowMs;
        this.start = nowMs;
    }
    tick(nowMs) {
        this.nowMs = nowMs;
    }
    mark(phase, nowMs) {
        this.marks.push({ phase, atMs: nowMs });
        this.metrics.record(this.turnId, phase, nowMs - this.start, nowMs);
        this.nowMs = nowMs;
    }
    /** 分阶段（差值）记录：第一阶段从起点算，之后按上一个标记算。 */
    segment(phase, nowMs) {
        const last = this.marks.length === 0 ? this.start : (this.marks[this.marks.length - 1]?.atMs ?? this.start);
        this.marks.push({ phase, atMs: nowMs });
        this.metrics.record(this.turnId, phase, nowMs - last, nowMs);
        this.nowMs = nowMs;
    }
    elapsed(nowMs) {
        return nowMs - this.start;
    }
    get currentMs() {
        return this.nowMs;
    }
}
//# sourceMappingURL=metrics.js.map