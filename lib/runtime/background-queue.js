/**
 * 后台任务队列（任务书 §6.1、§17.4、§10.5）。
 *
 * 目标：把「巩固记忆 / 后台提取 / 备份」这类慢动作挪出前台回合，且
 *   · 前台永远不等后台（§17.4「防止后台拖慢」）；
 *   · 同一 dedup_key 不会重复入队（重启、重试都靠它）；
 *   · 每次执行都有租约，进程崩了租约会自然过期，不产生永久锁；
 *   · 一个 timer，一个 worker，卸载时必须能停掉（§13.1 disposer）。
 *
 * 租约生命周期（ROUND2）：
 *   · 每次只领取「马上要跑的那一条」，所以还没开始的任务不会替前一条背租约；
 *   · handler 运行期间按 renewEveryMs（默认 leaseMs/3）周期续租，长任务不会被判成孤儿；
 *   · 续租 / 完成 / 失败重排都用 `id + status='leased' + 当前 attempts` 做条件更新，
 *     租约被别的 worker 接管后，旧 handler 的回写一律落空，不会覆盖新状态；
 *   · stop() 之后不再领下一条，正在跑的那条允许正常收尾（续租继续到它结束）。
 *   · 一轮 tick 内只有一个逻辑时钟：显式 nowMs 是本轮起点，其余时刻一律叠加注入时钟的增量；
 *     领取、续租、失败退避都读它，所以长 handler 跑过退避窗口再失败也不会在同一 tick 里重跑。
 *
 * 这里只管「调度与执行边界」，具体做什么由 handler 决定。
 */
export class BackgroundQueue {
    repos;
    metrics;
    options;
    handlers = new Map();
    tickMs;
    leaseMs;
    batch;
    maxRetries;
    renewEveryMs;
    clock;
    timer = null;
    running = false;
    stopping = false;
    claimedTotal = 0;
    doneTotal = 0;
    failedTotal = 0;
    staleTotal = 0;
    renewals = 0;
    lastError = null;
    inFlight = 0;
    constructor(repos, metrics, options = {}) {
        this.repos = repos;
        this.metrics = metrics;
        this.options = options;
        this.tickMs = Math.max(500, options.tickMs ?? 5_000);
        this.leaseMs = Math.max(5_000, options.leaseMs ?? 60_000);
        this.batch = Math.max(1, options.batch ?? 2);
        this.maxRetries = Math.max(0, options.maxRetries ?? 3);
        this.renewEveryMs = Math.max(50, options.renewEveryMs ?? Math.floor(this.leaseMs / 3));
        this.clock = options.now ?? (() => Date.now());
    }
    /** 注册一种任务的执行体；重复注册同一 kind 直接覆盖（热重载友好）。 */
    register(kind, handler) {
        this.handlers.set(kind, handler);
    }
    /** 入队；dedup_key 已存在时返回 false。 */
    enqueue(kind, payload, options) {
        try {
            const inserted = this.repos.enqueueJob({
                id: `${kind}:${options.dedupKey}`,
                dedupKey: options.dedupKey,
                principalId: options.principalId ?? null,
                kind,
                payload,
                availableAtMs: options.availableAtMs,
                createdAtMs: options.nowMs,
            });
            if (inserted)
                this.metrics.count(`bg.enqueued.${kind}`);
            return inserted;
        }
        catch (error) {
            this.lastError = describe(error);
            this.metrics.degrade(`后台任务入队失败：${this.lastError}`);
            return false;
        }
    }
    /**
     * 回收孤儿租约：启动时不可能持有任何租约，所以「已过期」的行一定是上次崩溃留下的。
     * 只碰已过期的行，不抢另一个活进程正在跑的任务（长任务靠周期续租保持「活」）。
     *
     * 连续过期不能绕过重试上限：handler 每次都在租约内跑不完（或每次把进程带走）时，
     * 光靠「重新排队」会变成无限重启循环。这里沿用失败路径的同一份预算
     * （共 maxRetries + 1 次执行），用完即判终结失败，和正常重试的语义一致。
     */
    reclaimOrphans(nowMs = this.clock(), maxAttempts = this.maxRetries + 1) {
        try {
            return this.repos.db.transaction(() => {
                const exhausted = this.repos.db.run("UPDATE background_jobs SET status = 'failed', lease_until_ms = NULL, last_error = ? WHERE status = 'leased' AND (lease_until_ms IS NULL OR lease_until_ms <= ?) AND attempts >= ?", '租约连续过期：任务始终未在租约内完成，判定失败，不再重排', nowMs, Math.max(1, maxAttempts)).changes;
                const reclaimed = this.repos.db.run("UPDATE background_jobs SET status = 'pending', lease_until_ms = NULL, available_at_ms = ? WHERE status = 'leased' AND (lease_until_ms IS NULL OR lease_until_ms <= ?)", nowMs, nowMs).changes;
                if (exhausted > 0) {
                    this.metrics.count('bg.reclaim-exhausted', exhausted);
                    this.metrics.degrade(`后台任务连续租约过期 ${exhausted} 条，判定失败`);
                }
                if (reclaimed > 0)
                    this.metrics.count('bg.reclaimed', reclaimed);
                return reclaimed;
            });
        }
        catch (error) {
            this.lastError = describe(error);
            return 0;
        }
    }
    start() {
        if (this.timer !== null || this.options.enabled === false)
            return;
        this.stopping = false;
        this.reclaimOrphans();
        this.timer = setInterval(() => {
            void this.tick();
        }, this.tickMs);
        // unref：后台队列不能单独把进程吊住（桌面端退出时可正常关）
        unrefTimer(this.timer);
    }
    /**
     * 一轮调度：最多跑 batch 条，但**每次只领一条**。
     *
     * 整批预领的代价是：第一条长任务跑超 leaseMs 时，还没开始的第 2..n 条也一起过期，
     * 被另一个 worker 重领——它们既没被执行过，也白白烧掉一次重试预算。
     */
    async tick(nowMs) {
        if (this.running || this.stopping)
            return;
        this.running = true;
        // 本轮的统一逻辑时钟：显式 nowMs 是本轮起点，之后一律叠加「注入时钟相对起点的增量」。
        // 这样固定时钟的调用方不会被真实 Date.now 带跑，而长 handler 自己推进的时间也能被看见。
        // 领取、续租、失败退避都走这一个 now()，不各算各的。
        const clockAtStart = this.clock();
        const tickStart = nowMs ?? clockAtStart;
        const now = () => tickStart + (this.clock() - clockAtStart);
        try {
            // 长活进程也要有界：每次 tick 先把过期租约收回来（含用尽重试预算的终结）。
            this.reclaimOrphans(now());
            for (let index = 0; index < this.batch; index += 1) {
                // stop() 之后不再领下一条；正在跑的那条已经进入 runOne，会正常收尾。
                if (this.stopping)
                    break;
                if (!this.repos.db.isOpen)
                    break;
                const at = now();
                const job = this.repos.claimJobs(at, this.leaseMs, 1)[0];
                if (job === undefined)
                    break;
                await this.runOne(job, now);
            }
        }
        catch (error) {
            this.lastError = describe(error);
            this.metrics.degrade(`后台队列 tick 异常：${this.lastError}`);
        }
        finally {
            this.running = false;
        }
    }
    /** 跑一条已领到租约的任务：续租 → 执行 → 条件回写 → 清理续租。 */
    async runOne(job, now) {
        const id = String(job['id'] ?? '');
        const kind = String(job['kind'] ?? '');
        // claimJobs 返回的是自增后的 attempts，就是本次租约的 CAS 令牌。
        const attempt = Number(job['attempts'] ?? 1);
        const handler = this.handlers.get(kind);
        this.claimedTotal += 1;
        if (handler === undefined) {
            this.repos.finishJob(id, 'cancelled', `no handler for ${kind}`, attempt);
            return;
        }
        this.inFlight += 1;
        const startedAt = now();
        const stopRenewal = this.startRenewal(id, attempt, now);
        try {
            await handler({
                id,
                kind,
                payload: parsePayload(job['payload_json']),
                attempt,
                previousError: typeof job['last_error'] === 'string' ? job['last_error'] : null,
            });
            // 库已经关了：不写回，让租约自然过期后由下一次启动回收。
            if (!this.repos.db.isOpen)
                return;
            if (this.repos.finishJob(id, 'done', undefined, attempt)) {
                this.doneTotal += 1;
                this.metrics.count(`bg.done.${kind}`);
            }
            else {
                this.abandonStale(kind, id);
            }
        }
        catch (error) {
            if (!this.repos.db.isOpen)
                return;
            this.lastError = describe(error);
            // attempt 是 1 基的本次执行序号，预算共 maxRetries + 1 次，与旧语义一致。
            // 退避基点是**失败发生的逻辑时刻**，不是领取时刻：长 handler 跑过整个退避窗口
            // 再抛错时，按领取时刻算出来的 available_at 已经在过去，同一 tick 会立刻重跑一遍。
            const failedAt = now();
            const settled = attempt >= this.maxRetries + 1
                ? this.repos.finishJob(id, 'failed', this.lastError, attempt)
                : this.repos.retryJob(id, attempt, failedAt + 1000 * 2 ** (attempt - 1), this.lastError);
            // 先做条件回写，再决定记什么账：只有真的改到自己那条租约（settled）才算一次失败。
            // 旧 worker 的异常如果因为租约被接管而落空，那是 stale，不是 failed——否则同一条
            // 任务会同时计入 failedTotal 与 staleTotal，和 staleTotal 的文档语义冲突。
            if (settled) {
                this.failedTotal += 1;
                this.metrics.count(`bg.failed.${kind}`);
                this.metrics.degrade(`后台任务失败（${kind}）：${this.lastError}`);
            }
            else {
                this.abandonStale(kind, id);
            }
        }
        finally {
            // 结束必须清掉续租计时器（成功、失败、库关闭、提前 return 都要走到这里）。
            stopRenewal();
            this.inFlight -= 1;
            this.metrics.record(id, 'assembly', now() - startedAt, now());
        }
    }
    /**
     * 运行期间周期续租。返回的 disposer 必须在 finally 里调用。
     * 续租失败（库关闭 / 租约已被接管）立即停表，不重试、不放大。
     */
    startRenewal(id, attempt, now) {
        const timer = setInterval(() => {
            try {
                if (!this.repos.db.isOpen) {
                    this.clearRenewal(timer);
                    return;
                }
                if (this.repos.renewJobLease(id, attempt, now(), this.leaseMs)) {
                    this.renewals += 1;
                    this.metrics.count('bg.renewed');
                }
                else {
                    // 这一行已经不归我们了：停表，让当前 handler 跑完由 CAS 落空处理。
                    this.clearRenewal(timer);
                }
            }
            catch (error) {
                this.lastError = describe(error);
                this.clearRenewal(timer);
            }
        }, this.renewEveryMs);
        unrefTimer(timer);
        return () => this.clearRenewal(timer);
    }
    clearRenewal(timer) {
        clearInterval(timer);
    }
    /** 租约被接管：不覆盖新 worker 的状态，只记一笔可观测性。 */
    abandonStale(kind, id) {
        this.staleTotal += 1;
        this.metrics.count('bg.stale');
        this.metrics.degrade(`后台任务租约已被接管，放弃回写（${kind} ${id}）`);
    }
    /** 等当前在跑的任务收尾（卸载时用，最多等 timeoutMs）。 */
    async drain(timeoutMs = 3_000) {
        const deadline = Date.now() + timeoutMs;
        while (this.inFlight > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return this.inFlight === 0;
    }
    stop() {
        this.stopping = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    stats() {
        return {
            running: this.timer !== null,
            tickMs: this.tickMs,
            claimedTotal: this.claimedTotal,
            doneTotal: this.doneTotal,
            failedTotal: this.failedTotal,
            staleTotal: this.staleTotal,
            renewals: this.renewals,
            activeLeases: this.inFlight,
            lastError: this.lastError,
            handlers: [...this.handlers.keys()].sort(),
        };
    }
    /** 供 doctor 展示的「库里还剩多少任务」。 */
    backlog() {
        try {
            return this.repos.jobStats();
        }
        catch {
            return {};
        }
    }
    get isRunning() {
        return this.timer !== null;
    }
}
function unrefTimer(timer) {
    const handle = timer;
    handle.unref?.();
}
function parsePayload(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object')
            return parsed;
        return {};
    }
    catch {
        return {};
    }
}
function describe(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
//# sourceMappingURL=background-queue.js.map