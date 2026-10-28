import { checkGates, startOfDayMs } from './candidate-builder.js';
import { proactiveFrequency } from './frequency.js';
import { computerEvidence } from './computer-evidence.js';
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js';
/** 可重试的错误码：只认平台明确说过「稍后再试」的那几类。 */
const RETRYABLE_CODES = new Set([
    'rate_limited',
    'overload',
    'server_error',
    'network_error',
    'timeout',
]);
function str(row, key) {
    const value = row[key];
    return typeof value === 'string' ? value : null;
}
function num(row, key) {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export class OutboxWorker {
    options;
    now;
    running = false;
    get busy() { return this.running; }
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * 取一批待发消息并逐条投递。
     *
     * 返回的每一项都对应 outbox 里真实发生过的一次状态变化，供 scheduler 记账
     * 与 `/fish status` 展示；调用方不依赖它做业务判断。
     */
    async runOnce(nowMs = this.now()) {
        const { repos, transport, metrics } = this.options;
        // 重启后的自救：sending 一律降级 unknown，避免「可能已发」被当成失败重发。
        if (this.running)
            return [];
        this.running = true;
        try {
            await this.options.beforeDelivery?.();
            const rows = repos.claimOutbox(nowMs, this.options.limit ?? 5);
            const outcomes = [];
            for (const row of rows) {
                const id = str(row, 'id');
                const conversationId = str(row, 'conversation_id');
                if (id === null || conversationId === null)
                    continue;
                const chatId = this.options.chatForConversation(conversationId);
                if (chatId === null) {
                    repos.cancelOutbox(id, 'no_chat_target');
                    outcomes.push({ id, status: 'cancelled', reason: 'no_chat_target', chatId: null });
                    metrics.count('outbox.cancelled', 1);
                    continue;
                }
                const cancelled = this.recheck(row, conversationId, nowMs);
                if (cancelled !== null) {
                    repos.cancelOutbox(id, cancelled);
                    outcomes.push({ id, status: 'cancelled', reason: cancelled, chatId });
                    metrics.count(`outbox.cancelled.${cancelled}`, 1);
                    continue;
                }
                const content = str(row, 'content') ?? '';
                if (content.trim().length === 0) {
                    repos.cancelOutbox(id, 'empty_content');
                    outcomes.push({ id, status: 'cancelled', reason: 'empty_content', chatId });
                    continue;
                }
                const startedAt = this.now();
                let receipt;
                try {
                    receipt = this.options.send ? await this.options.send(conversationId, content, id, num(row, 'expected_inbound_seq')) : await transport.sendText(chatId, content);
                }
                catch (error) {
                    // 传输层自身抛错 = 我们不知道平台有没有收到：按 unknown 处理，不重发。
                    receipt = { kind: 'unknown', code: 'transport_threw', atMs: this.now() };
                    metrics.degrade(`主动消息发送异常：${error instanceof Error ? error.message : String(error)}`);
                }
                metrics.span('', 'send', startedAt, this.now());
                repos.finishOutbox(id, receipt);
                if (receipt.kind === 'accepted' && !repos.db.get("SELECT id FROM raw_messages WHERE conversation_id = ? AND role = 'assistant' AND platform_message_key = ?", conversationId, receipt.platformMessageId ?? id))
                    repos.insertRawMessage({ id: `outbox:${id}`, conversationId, platformMessageKey: receipt.platformMessageId ?? id, role: 'assistant', sourceKind: 'proactive', content, occurredAtMs: receipt.atMs, observedAtMs: receipt.atMs, deliveryStatus: 'accepted', deletedAtMs: null });
                const opportunity = str(row, 'opportunity_id');
                if (opportunity && receipt.kind === 'accepted')
                    repos.db.run("UPDATE proactive_opportunities SET status = 'sent' WHERE id = ?", opportunity);
                const taskId = str(row, 'task_id');
                if (receipt.kind === 'accepted' && taskId !== null) {
                    // 提醒发出后即完成；未确认的提醒不在这里改状态（它还需要用户确认）。
                    const task = repos.dueTasks(nowMs, 100).find(item => str(item, 'id') === taskId);
                    if (task !== undefined)
                        repos.setTaskStatus(taskId, 'done');
                }
                if (receipt.kind === 'accepted') {
                    outcomes.push({ id, status: 'sent', receipt, chatId });
                    metrics.count('outbox.sent', 1);
                }
                else if (receipt.kind === 'rejected') {
                    const code = receipt.code ?? 'unknown_reject';
                    const attempts = num(row, 'attempts') ?? 0;
                    const retryable = RETRYABLE_CODES.has(code) && attempts < 2;
                    outcomes.push({ id, status: 'failed', receipt, chatId, retryable });
                    metrics.count('outbox.failed', 1);
                    if (retryable) {
                        // 回到 pending 让下一轮再试；attempts 已在 claim 时 +1。
                        repos.replanOutbox(id, nowMs + 60_000);
                    }
                }
                else {
                    outcomes.push({ id, status: 'unknown', receipt, chatId });
                    metrics.count('outbox.unknown', 1);
                    metrics.degrade('主动消息回执 unknown：可能已送达，不自动重发');
                }
            }
            return outcomes;
        }
        finally {
            this.running = false;
        }
    }
    /** 发送前复核（§14.4）。返回取消原因，null 表示可以发。 */
    recheck(row, conversationId, nowMs) {
        const { repos, config } = this.options;
        if (this.options.targetBusy?.(conversationId))
            return 'main-turn-in-flight';
        const expected = num(row, 'expected_inbound_seq');
        if (expected !== null) {
            const latest = repos.latestInboundSeq(conversationId);
            if (latest > expected)
                return 'user_spoke_first';
        }
        const taskId = str(row, 'task_id');
        let isReminder = false;
        if (taskId !== null) {
            const task = repos.db.get('SELECT kind, status, expires_at_ms FROM tasks WHERE id = ? AND conversation_id = ?', taskId, conversationId);
            if (!task || !['confirmed', 'proposed'].includes(task.status))
                return 'task_finished';
            isReminder = task.kind === 'reminder';
            if (isReminder && task.status !== 'confirmed')
                return 'task_unconfirmed';
            if (task.expires_at_ms !== null && task.expires_at_ms <= nowMs)
                return 'task_expired';
        }
        const plannedAt = num(row, 'planned_at_ms') ?? nowMs;
        // 过期兜底：超过一天的主动消息不再补发（陈旧问候不如不发）。
        if (nowMs - plannedAt > 24 * 60 * 60_000)
            return 'expired';
        if (taskId !== null) {
            const task = repos.dueTasks(nowMs, 100).find(item => str(item, 'id') === taskId);
            if (task === undefined) {
                // 提醒可能已经完成或被取消：只有确认过状态才取消。
                const pending = repos.pendingTasks(conversationId, 50).find(item => str(item, 'id') === taskId);
                if (pending === undefined)
                    return 'task_finished';
            }
        }
        if (!isReminder) {
            const conversation = repos.db.get('SELECT principal_id FROM conversations WHERE id = ?', conversationId);
            const gates = checkGates({ config, repos, conversationId, principalId: conversation?.principal_id ?? '', nowMs });
            const frequency = proactiveFrequency(config, repos, conversation?.principal_id ?? '', nowMs);
            const blocked = gates.blocked.filter(code => !['daily-limit', 'global-daily-limit', 'awaiting-reply'].includes(code));
            if (blocked.length)
                return blocked.join(',');
            const day = startOfDayMs(nowMs, config.proactive.timezone);
            const others = repos.db.all(`SELECT * FROM outbox WHERE id <> ? AND ${SPONTANEOUS_OUTBOX} AND status IN ('sent','unknown') ORDER BY sent_at_ms DESC`, row['id']);
            if (others.filter(other => Number(other['sent_at_ms'] ?? other['planned_at_ms']) >= day).length >= frequency.dailyLimit)
                return 'global-daily-limit';
            const last = others[0];
            if (last && nowMs - Number(last['sent_at_ms'] ?? last['planned_at_ms']) < frequency.minGapMinutes * 60000)
                return 'cooldown';
            const unresolved = repos.unresolvedOutbox(conversationId, 0, nowMs - 24 * 3600_000).filter(other => other['id'] !== row['id'] && ['sent', 'unknown'].includes(String(other['status'])));
            if (unresolved.length >= config.proactive.pauseAfterUnanswered)
                return 'awaiting-reply';
            const opportunity = str(row, 'opportunity_id');
            if (opportunity?.startsWith('op:')) {
                const live = repos.db.get('SELECT status, expires_at_ms, kind, principal_id, source_ids_json FROM proactive_opportunities WHERE id = ?', opportunity);
                if (!live || live.status === 'cancelled' || live.expires_at_ms <= nowMs)
                    return 'opportunity-expired';
                if (live.kind === 'computer_event') {
                    const sources = JSON.parse(live.source_ids_json);
                    if (!sources.some(id => { const evidence = computerEvidence(repos, id, live.principal_id, conversationId, nowMs); return evidence && (evidence.source === 'interface' ? config.perception.enabled : config.computerEvents.enabled); }))
                        return 'computer-evidence-expired';
                }
            }
        }
        return null;
    }
}
//# sourceMappingURL=outbox-worker.js.map