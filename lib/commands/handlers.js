/**
 * QQ 斜杠命令（任务书 §15.1）。
 *
 * 设计约束：
 *   - 这里的每条命令都必须能在**不经过模型**的情况下工作：用户敲 `/fish status`
 *     时不该先跑一轮生成。
 *   - 管理类命令（personality / proactive / reset / forget / correct）只认
 *     owner 私聊；群里任何人都能查 status/mood/memory，但看不到别人的记忆。
 *   - 破坏性命令要 `--confirm`。缺确认时**只提示一次**并带上完整可复制的命令，
 *     用户补上 `--confirm` 就执行——不允许反问两次（§15.1 明确禁止）。
 *   - 命令本身**不改关系**：管理命令一律只动配置/派生数据，不动 affect。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS, INITIAL_RELATIONSHIP, initialSnapshot, projectSnapshot, summarizeState } from '../domain/affect-reducer.js';
import { rebuildAffect } from '../domain/affect-projector.js';
import { personalityPreset } from '../domain/personality.js';
import { PersonalityProfiles } from '../storage/personality-profiles.js';
import { randomUUID } from 'node:crypto';
import { SPONTANEOUS_OUTBOX } from '../storage/outbox-policy.js';
import { backupNow, backupSummary, backupDirectory } from '../storage/backup.js';
import { deleteScope } from '../storage/deletion.js';
import { migrationStatus } from '../storage/migrations.js';
import { describeCompatibility } from '../adapters/compatibility.js';
const HELP_TEXT = [
    '可用命令：',
    '/fish status — 运行状态、库大小、投递统计',
    '/fish mood — 当前情绪（加 1 看数值）',
    '/fish why — 最近一次态度变化的原因',
    '/fish memory <关键词> — 搜我记住的东西',
    '/fish remember <内容> — 让我记住一句话',
    '/fish forget <记忆ID> --confirm — 忘掉一条记忆',
    '/fish correct <事件序号> <说明> — 更正一条影响关系的判断',
    '/fish personality irritable|balanced|gentle — 换性格（owner）',
    '/fish personality show | mix gentle=.45 earnest=.35 playful=.20 — 组合人格',
    '/fish expression why — 表达检查与降级记录',
    '/fish habits list | forget <id> — 交流习惯',
    '/fish proactive on|off — 开关主动消息（owner）',
    '/fish proactive why | pause | resume | device take — 主动原因与设备接管',
    '/fish reset relationship --confirm — 关系归零（owner）',
    '/fish export — 导出完整记忆文件并安排网盘上传（owner）',
    '/fish import <文件路径> — 导入完整记忆文件（owner）',
    '/fish files — 打开记忆导入导出与网盘管理页（owner）',
    '/fish sync — 检查云端并同步（owner）',
    '/fish doctor — 自检',
    '/fish review begin friendly|tense|after_conflict / end — 隔离测试场景',
].join('\n');
/** 命令名 → 是否需要 owner。 */
const OWNER_ONLY = new Set(['review', 'personality', 'proactive', 'reset', 'forget', 'correct', 'habits', 'expression', 'export', 'import', 'files', 'sync']);
function fail(text) {
    return { kind: 'error', text };
}
function ok(text, mutated = false) {
    return { kind: 'success', text, mutated };
}
function pct(value) {
    return `${Math.round(value * 100)}%`;
}
function fmtTime(ms, timezone) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
        return '—';
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(new Date(ms));
    }
    catch {
        return new Date(ms).toISOString();
    }
}
function bytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function currentSnapshot(deps, binding, nowMs) {
    const stored = deps.repos.getSnapshot(binding.principalId);
    if (!stored) {
        return initialSnapshot(binding.principalId, deps.config.companion.preset, deps.config.affect.ruleVersion, nowMs);
    }
    return projectSnapshot(stored.snapshot, nowMs, deps.config.affect);
}
/** 解析 `--confirm` 之类的布尔开关。 */
function flag(args, name) {
    return args.includes(`--${name}`);
}
function stripFlags(args) {
    return args.filter((a) => !a.startsWith('--'));
}
export function handleFishCommand(input, deps) {
    const raw = input.raw.trim();
    if (raw === '' || raw === 'help' || raw === '?')
        return ok(HELP_TEXT);
    const tokens = raw.split(/\s+/u);
    const name = (tokens[0] ?? '').toLowerCase();
    const rest = tokens.slice(1);
    const args = stripFlags(rest);
    if (OWNER_ONLY.has(name) && !input.isOwner) {
        return fail('这条命令只能在 owner 私聊里用。');
    }
    if (deps.transfer && !deps.transfer.isReady && ['export', 'import'].includes(name))
        return fail('启动记忆同步正在进行，请完成后再导入导出。');
    switch (name) {
        case 'expression':
            return ok(JSON.stringify({ mode: deps.config.expression.mode, recent: deps.db.all('SELECT mode, issues_json, status, repair_calls, latency_ms FROM expression_audits WHERE principal_id = ? ORDER BY created_at_ms DESC LIMIT 3', input.binding.principalId) }, null, 2));
        case 'habits': {
            if (args[0] === 'forget' && args[1]) {
                const updated = deps.db.run("UPDATE expression_habits SET status = 'revoked' WHERE id = ? AND principal_id = ?", args[1], input.binding.principalId);
                return updated.changes ? ok('已撤销这条交流习惯。', true) : fail('没有找到这条习惯。');
            }
            return ok(JSON.stringify(deps.db.all('SELECT id, kind, value_json, status, source_ids_json FROM expression_habits WHERE principal_id = ? ORDER BY valid_from_ms DESC LIMIT 20', input.binding.principalId), null, 2));
        }
        case 'review':
            if (!deps.review)
                return fail('当前入口不支持 review。');
            try {
                if (args[0] === 'begin')
                    return ok(deps.review.begin(args[1] ?? ''), true);
                if (args[0] === 'end')
                    return ok(deps.review.end(), true);
                return fail('用法：/fish review begin friendly|tense|after_conflict，或 /fish review end');
            }
            catch (error) {
                return fail(String(error.message));
            }
        case 'status':
            return commandStatus(deps, input);
        case 'mood':
            return commandMood(deps, input, rest);
        case 'why':
            return commandWhy(deps, input);
        case 'memory':
            return commandMemory(deps, input, args.join(' ').trim());
        case 'remember':
            return commandRemember(deps, input, args.join(' ').trim());
        case 'forget':
            return commandForget(deps, input, args, flag(rest, 'confirm'));
        case 'correct':
            return commandCorrect(deps, input, args);
        case 'personality':
            return commandPersonality(deps, input, args);
        case 'proactive':
            return commandProactive(deps, input, args);
        case 'reset':
            return commandReset(deps, input, flag(rest, 'confirm'));
        case 'export':
            if (deps.transfer) {
                try {
                    const result = deps.transfer.exportLocal();
                    return ok(`完整记忆文件：${result.file}\n原文 ${result.messages} 条，记忆 ${result.memories} 条。${result.upload === 'queued' ? '\n已安排网盘同步，可在管理页查看结果。' : ''}\n导出下载与网盘管理：${deps.manageUrl?.() ?? '/companion-memory/manage'}`);
                }
                catch {
                    return fail('记忆导出失败，请检查存储目录权限。');
                }
            }
            return commandExport(deps, input);
        case 'files':
            return ok(`记忆导入导出与百度网盘：${deps.manageUrl?.() ?? '/companion-memory/manage'}`);
        case 'sync': {
            if (!deps.transfer)
                return fail('当前入口未挂载记忆同步服务。');
            const file = deps.publishLocal?.();
            void deps.transfer.sync();
            return ok(`${file ? `同步文件：${file}` : '本机同步服务已就绪。'}\n${deps.transfer.status().enabled ? '已安排云端检查与同步。' : '百度网盘尚未连接。'}查看进度：${deps.manageUrl?.() ?? '/companion-memory/manage'}`);
        }
        case 'import':
            if (!deps.transfer)
                return fail('当前入口未挂载记忆导入服务。');
            if (!args.length)
                return ok(`在这里选择要导入的记忆文件：${deps.manageUrl?.() ?? '/companion-memory/manage'}`);
            try {
                const result = deps.transfer.importFile(args.join(' ').replace(/^"|"$/g, ''));
                if (deps.transfer.status().enabled)
                    void deps.transfer.sync();
                return ok(`记忆导入完成：新增 ${result.inserted}，更新 ${result.updated}，冲突 ${result.conflicts}。${result.alreadyImported ? '该文件已处理。' : ''}${result.lineageMissing ? '缺少共同历史，差异已保留。' : ''}`, true);
            }
            catch {
                return fail('记忆导入失败：请检查文件、版本及所属主人；本地记忆已保留。');
            }
        case 'doctor':
            return commandDoctor(deps, input);
        default:
            // 未知命令 → help（§15.1），不报错刷屏
            return ok(`没有 /fish ${name} 这条命令。\n${HELP_TEXT}`);
    }
}
function commandStatus(deps, input) {
    const { repos, config, metrics } = deps;
    const counts = repos.counts();
    const lines = [`状态 · ${config.companion.name}（${personalityPreset(repos, config, input.binding.principalId)}）`];
    lines.push(`记忆：${counts['memories'] ?? 0} 条 · 原文：${counts['raw_messages'] ?? 0} 条`);
    lines.push(`对话轮次：${counts['turns'] ?? 0} · 情感事件：${counts['affect_events'] ?? 0}`);
    lines.push(`任务：${counts['tasks'] ?? 0} · 待发：${counts['outbox'] ?? 0}`);
    lines.push(`库大小：${bytes(repos.databaseBytes())}`);
    lines.push(`会话：${input.isOwner ? 'owner 私聊' : '受限会话'} · ${input.binding.conversationKind}`);
    const summary = metrics.summary();
    if (summary !== '')
        lines.push(`延迟：${summary}`);
    if (deps.scheduler) {
        const s = deps.scheduler.status();
        const tail = s.pending > 0 ? `，待评估 ${s.pending}` : '';
        lines.push(`主动消息：${s.enabled ? '开' : '关'}${tail}`);
        if (s.suppressedReason)
            lines.push(`抑制原因：${s.suppressedReason}`);
    }
    if (deps.outboxStats) {
        const o = deps.outboxStats();
        const pairs = Object.entries(o).map(([k, v]) => `${k} ${v}`);
        if (pairs.length > 0)
            lines.push(`发件箱：${pairs.join(' · ')}`);
    }
    return ok(lines.join('\n'));
}
function commandMood(deps, input, rest) {
    const snapshot = currentSnapshot(deps, input.binding, input.nowMs);
    const summary = summarizeState(snapshot);
    const numeric = rest.some((a) => /^\d+$/u.test(a));
    const lines = [`心情：${summary.moodLevels}`, `关系：${summary.relationshipLevels}`];
    if (summary.episodeHint)
        lines.push(summary.episodeHint);
    if (numeric) {
        const m = snapshot.mood;
        const r = snapshot.relationship;
        lines.push(`数值 情绪 怒${m.anger.toFixed(2)} 伤${m.hurt.toFixed(2)} 喜${m.joy.toFixed(2)} 紧${m.tension.toFixed(2)}`);
        lines.push(`数值 关系 亲${r.affection.toFixed(2)} 信${r.trust.toFixed(2)} 敬${r.respect.toFixed(2)} 熟${r.familiarity.toFixed(2)} 怨${r.grievance.toFixed(2)}`);
    }
    return ok(lines.join('\n'));
}
function commandWhy(deps, input) {
    const event = deps.repos.lastAffectEvent(input.binding.principalId);
    if (!event)
        return ok('我这边还没有记录到态度变化。');
    const payload = safeJson(event['payload_json']);
    const lines = [
        `最近一次态度变化：#${String(event['seq'])}（${fmtTime(Number(event['event_time_ms']), deps.config.proactive.timezone)}）`,
    ];
    const kind = payload?.appraisal?.kind;
    if (kind)
        lines.push(`事件类型：${kind}`);
    const explanations = payload?.explanations ?? [];
    if (explanations.length > 0) {
        for (const e of explanations.slice(0, 4))
            lines.push(`· ${e}`);
    }
    else {
        lines.push('· 没有更细的解释记录');
    }
    if (typeof payload?.scale === 'number')
        lines.push(`影响强度：${pct(payload.scale)}`);
    lines.push(`（要更正就发 /fish correct ${String(event['seq'])} <说明>）`);
    return ok(lines.join('\n'));
}
function commandMemory(deps, input, keyword) {
    if (keyword === '')
        return fail('用法：/fish memory <关键词>');
    const result = deps.retriever.retrieve({
        binding: input.binding,
        query: keyword,
        nowMs: input.nowMs,
    });
    if (result.selected.length === 0) {
        return ok(`没搜到跟「${keyword}」有关的记忆。`);
    }
    const lines = [`搜到 ${result.selected.length} 条（候选 ${result.candidates.length}）：`];
    for (const scored of result.selected.slice(0, 5)) {
        lines.push(`· [${scored.item.kind}] ${scored.item.claim}`);
        lines.push(`  id: ${scored.item.id}`);
    }
    return ok(lines.join('\n'));
}
function commandRemember(deps, input, content) {
    if (content === '')
        return fail('用法：/fish remember <内容>');
    if (content.length > 200)
        return fail('太长了，一句话记不住。200 字以内。');
    const now = input.nowMs;
    const id = `mem_owner_${hashText(`${input.binding.principalId}:${content}:${Math.floor(now / 1000)}`)}`;
    const outcome = deps.updater.write({
        id,
        principalId: input.binding.principalId,
        conversationId: input.binding.conversationId,
        visibility: input.binding.visibility,
        kind: 'fact',
        subject: 'owner',
        predicate: null,
        object: { text: content },
        claim: content,
        sourceKind: 'owner_statement',
        confidence: 0.95,
        salience: 0.7,
        validFromMs: now,
        validToMs: null,
        eventAtMs: now,
        observedAtMs: now,
        evidence: [],
    });
    switch (outcome.type) {
        case 'rejected':
            return fail(`这条没记住：${outcome.reason}`);
        case 'unchanged':
            return ok('这条我本来就记着。');
        case 'conflict':
            return ok('记下了，不过和我之前记的有点冲突，我按新的来。', true);
        case 'inserted':
            return ok('记住了。', true);
    }
}
function commandForget(deps, input, args, confirmed) {
    const id = args[0] ?? '';
    if (id === '')
        return fail('用法：/fish forget <记忆ID> --confirm');
    const memory = deps.repos.getMemory(id);
    if (!memory || memory.principal_id !== input.binding.principalId)
        return fail(`没有 id 为 ${id} 的当前用户记忆。`);
    if (!confirmed) {
        // 只提示一次，带上可直接复制的完整命令
        return ok(`要忘掉「${memory.claim}」就发：\n/fish forget ${id} --confirm`);
    }
    const result = deleteScope(deps.db, deps.repos, input.binding.principalId, { kind: 'memory', memoryId: id }, input.nowMs, deps.config.storage.backupRetentionDays, deps.config);
    const notes = result.notes.length > 0 ? `\n${result.notes.join('\n')}` : '';
    return ok(`忘掉了：${result.removedMemories.length} 条记忆、${result.removedMessages.length} 条原文。${notes}`, true);
}
function commandCorrect(deps, input, args) {
    const rawId = args[0] ?? '';
    const explanation = args.slice(1).join(' ').trim();
    if (rawId === '')
        return fail('用法：/fish correct <事件序号> <说明>');
    if (explanation === '')
        return fail('得说一句为什么，不然我不知道该按哪边改。');
    const seq = Number.parseInt(rawId.replace(/^#/u, ''), 10);
    if (!Number.isFinite(seq) || seq <= 0) {
        // 也接受记忆 id：更正记忆比更正事件更常见
        const memory = deps.repos.getMemory(rawId);
        if (!memory || memory.principal_id !== input.binding.principalId)
            return fail(`找不到当前用户的事件或记忆 ${rawId}。`);
        const outcome = deps.updater.retract(memory.id, `owner_correction: ${explanation}`, input.nowMs);
        if (outcome.notFound)
            return fail('这条记忆已经不在了。');
        return ok(`撤回了 ${outcome.retracted} 条记忆，连带 ${outcome.cascaded} 条派生项。`, true);
    }
    const event = deps.repos.getAffectEvent(seq);
    if (!event)
        return fail(`没有序号为 ${seq} 的情感事件。`);
    if (String(event['principal_id']) !== input.binding.principalId) {
        return fail('这条事件不属于当前对话。');
    }
    if (String(event['status']) !== 'active')
        return fail('这条事件已经被撤回过。');
    deps.db.transaction(() => {
        deps.repos.retractAffectEvent(seq, explanation);
        const stored = deps.repos.getSnapshot(input.binding.principalId);
        const snapshot = rebuildAffect(deps.repos, deps.config, input.binding.principalId, input.nowMs);
        deps.repos.putSnapshot(snapshot, stored?.revision ?? 0);
    });
    deps.repos.audit({
        principalId: input.binding.principalId,
        kind: 'affect.corrected',
        entityId: String(seq),
        payload: { explanation },
        createdAtMs: input.nowMs,
    });
    return ok(`更正了 #${seq}：${explanation}`, true);
}
function commandPersonality(deps, input, args) {
    const persona = deps.repos.getSetting(`persona.id:${input.binding.principalId}`) ?? 'builtin';
    const profiles = new PersonalityProfiles(deps.repos);
    if (args[0] === 'show')
        return ok(JSON.stringify(profiles.get(deps.config.companion.id, persona) ?? { legacy: currentSnapshot(deps, input.binding, input.nowMs).personality }, null, 2));
    if (args[0] === 'set') {
        try {
            const overrides = {};
            for (const entry of args.slice(1)) {
                const match = /^([a-zA-Z]+)=(\d*\.?\d+)$/.exec(entry);
                if (!match || Object.hasOwn(overrides, match[1]))
                    throw new Error('用法：personality set reserve=.65 warmth=.8');
                overrides[match[1]] = Number(match[2]);
            }
            if (!Object.keys(overrides).length)
                throw new Error('至少指定一个维度');
            const stored = deps.repos.getSnapshot(input.binding.principalId), base = currentSnapshot(deps, input.binding, input.nowMs);
            const previous = profiles.get(deps.config.companion.id, persona);
            const profile = profiles.configure(deps.config.companion.id, persona, previous?.traits ?? base.personality, { mix: Object.fromEntries(previous?.templates.map(item => [item.id, item.weight]) ?? []), overrides: { ...previous?.explicitOverrides, ...overrides }, variation: { enabled: previous?.seed !== null && previous?.seed !== undefined, maxDelta: .05, seed: previous?.seed ?? null } }, input.nowMs);
            const personality = Object.fromEntries(Object.keys(base.personality).map(key => [key, profile.traits[key]]));
            deps.repos.putSnapshot({ ...base, personality, revision: (stored?.revision ?? 0) + 1 }, stored?.revision ?? 0);
            return ok('人格维度已保存。', true);
        }
        catch (error) {
            return fail(String(error));
        }
    }
    if (args[0] === 'mix') {
        try {
            const mix = {};
            for (const entry of args.slice(1)) {
                const match = /^([a-z]+)=(\d*\.?\d+)$/.exec(entry);
                if (!match || Object.hasOwn(mix, match[1]))
                    throw new Error('用法：personality mix gentle=.45 earnest=.35 playful=.20');
                mix[match[1]] = Number(match[2]);
            }
            if (!Object.keys(mix).length)
                throw new Error('至少指定一个模板及权重');
            const stored = deps.repos.getSnapshot(input.binding.principalId);
            const base = currentSnapshot(deps, input.binding, input.nowMs);
            const profile = profiles.configure(deps.config.companion.id, persona, base.personality, { mix, overrides: {}, variation: { enabled: false, maxDelta: .05, seed: null } }, input.nowMs);
            const personality = Object.fromEntries(Object.keys(base.personality).map(key => [key, profile.traits[key]]));
            deps.repos.putSnapshot({ ...base, personality, revision: (stored?.revision ?? 0) + 1 }, stored?.revision ?? 0);
            return ok(`人格组合已保存：${JSON.stringify(mix)}`, true);
        }
        catch (error) {
            return fail(String(error));
        }
    }
    const preset = (args[0] ?? '').toLowerCase();
    if (preset !== 'irritable' && preset !== 'balanced' && preset !== 'gentle') {
        return fail('可选性格：irritable / balanced / gentle');
    }
    const personality = PRESETS[preset];
    profiles.configure(deps.config.companion.id, persona, personality, { mix: {}, overrides: { ...(profiles.get(deps.config.companion.id, persona)?.traits ?? {}), ...personality }, variation: { enabled: false, maxDelta: .05, seed: null } }, input.nowMs);
    deps.repos.setSetting(`personality.preset:${input.binding.principalId}`, preset, input.nowMs);
    deps.repos.setSetting(`personality.default:${input.binding.principalId}`, preset, input.nowMs);
    const companion = deps.repos.ensureCompanion(deps.config.companion.id, deps.config.companion.name, personality, input.nowMs);
    void companion;
    const stored = deps.repos.getSnapshot(input.binding.principalId);
    const base = stored
        ? stored.snapshot
        : initialSnapshot(input.binding.principalId, preset, deps.config.affect.ruleVersion, input.nowMs);
    deps.repos.putSnapshot({
        ...base,
        personality,
        revision: (stored?.revision ?? 0) + 1,
        asOfMs: input.nowMs,
    }, stored?.revision ?? 0);
    deps.repos.audit({
        principalId: input.binding.principalId,
        kind: 'personality.changed',
        entityId: preset,
        payload: { preset },
        createdAtMs: input.nowMs,
    });
    return ok(`性格切成 ${preset} 了。`, true);
}
function commandProactive(deps, input, args) {
    const value = (args[0] ?? '').toLowerCase();
    if (value === 'feedback' && args[1] && args[2]) {
        const kinds = ['positive', 'negative', 'busy', 'explicit_preference', 'unrelated', 'unknown'];
        if (!kinds.includes(args[2]))
            return fail('无效反馈类型。');
        const row = deps.db.get('SELECT * FROM proactive_feedback WHERE id = ? AND principal_id = ?', args[1], input.binding.principalId);
        if (!row)
            return fail('未找到当前角色的反馈记录。');
        deps.db.run('INSERT INTO proactive_feedback VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)', randomUUID(), row['opportunity_id'], row['outbox_id'], input.binding.principalId, args[2], `owner correction: ${args[2]}`, 'feedback-owner-v1', args[1], input.nowMs);
        return ok('已更正反馈归因，接受倾向将从有效记录重算。', true);
    }
    if (value === 'device' && args[1] === 'take') {
        const device = deps.repos.getSetting('local.device-id');
        if (!device)
            return fail('当前设备尚未注册。');
        const previous = deps.db.get('SELECT revision_id, conflict_json FROM proactive_ownership WHERE companion_id = ?', deps.config.companion.id);
        const parents = [...new Set([...(previous ? [previous.revision_id] : []), ...(previous?.conflict_json ? JSON.parse(previous.conflict_json) : [])])];
        deps.db.run('INSERT INTO proactive_ownership VALUES (?, ?, ?, ?, NULL) ON CONFLICT(companion_id) DO UPDATE SET active_device_id = excluded.active_device_id, revision_id = excluded.revision_id, parent_revision_ids_json = excluded.parent_revision_ids_json, conflict_json = NULL', deps.config.companion.id, device, randomUUID(), JSON.stringify(parents));
        return ok('本机已接管主动发送。旧电脑在收到同步前仍可能发送，请先在旧机暂停或完成同步。', true);
    }
    if (value === 'why')
        return ok(JSON.stringify({ device: deps.db.get('SELECT * FROM proactive_ownership WHERE companion_id = ?', deps.config.companion.id), opportunities: deps.db.all('SELECT kind, summary, status, not_before_ms, expires_at_ms FROM proactive_opportunities WHERE principal_id = ? ORDER BY created_at_ms DESC LIMIT 10', input.binding.principalId) }, null, 2));
    const resolved = value === 'pause' ? 'off' : value === 'resume' ? 'on' : value;
    if (resolved !== 'on' && resolved !== 'off')
        return fail('用法：/fish proactive on|off|pause|resume|why|device take');
    const enabled = resolved === 'on';
    if (!enabled)
        deps.db.run(`UPDATE outbox SET status = 'cancelled' WHERE ${SPONTANEOUS_OUTBOX} AND status = 'pending'`);
    deps.repos.setSetting('proactive.enabled', enabled ? '1' : '0', input.nowMs);
    deps.scheduler?.setEnabled(enabled);
    deps.repos.audit({
        principalId: input.binding.principalId,
        kind: 'proactive.toggled',
        entityId: String(enabled),
        payload: { enabled },
        createdAtMs: input.nowMs,
    });
    return ok(enabled ? '主动消息开了。' : '主动消息关了。已确认的提醒照常发。', true);
}
function commandReset(deps, input, confirmed) {
    if (!confirmed) {
        return ok('这会清掉亲密度、信任、怨气这些关系状态（记忆保留）。确认就发：\n/fish reset relationship --confirm');
    }
    const stored = deps.repos.getSnapshot(input.binding.principalId);
    const fresh = initialSnapshot(input.binding.principalId, personalityPreset(deps.repos, deps.config, input.binding.principalId), deps.config.affect.ruleVersion, input.nowMs);
    deps.db.transaction(() => {
        deps.db.run("UPDATE affect_events SET status = 'superseded' WHERE principal_id = ? AND status = 'active'", input.binding.principalId);
        deps.db.run("UPDATE relationship_episodes SET status = 'archived' WHERE principal_id = ?", input.binding.principalId);
        deps.repos.setSetting(`affect.baseline:${input.binding.principalId}`, JSON.stringify(fresh), input.nowMs);
        deps.repos.putSnapshot({ ...fresh, relationship: { ...INITIAL_RELATIONSHIP }, revision: (stored?.revision ?? 0) + 1 }, stored?.revision ?? 0);
    });
    deps.repos.audit({
        principalId: input.binding.principalId,
        kind: 'relationship.reset',
        entityId: input.binding.principalId,
        payload: {},
        createdAtMs: input.nowMs,
    });
    return ok('关系重置了。记忆没动。', true);
}
function commandExport(deps, input) {
    const { config, repos } = deps;
    const directory = join(config.storage.directory, 'exports');
    try {
        mkdirSync(directory, { recursive: true });
    }
    catch (error) {
        return fail(`导出失败：建不了目录（${error.message}）`);
    }
    const snapshot = currentSnapshot(deps, input.binding, input.nowMs);
    const memories = repos.allMemories(input.binding.principalId, 5000).map((row) => ({
        id: row.id,
        kind: row.kind,
        claim: row.claim,
        confidence: row.confidence,
        salience: row.salience,
        observedAtMs: row.observed_at_ms,
    }));
    const episodes = repos.listEpisodes(input.binding.principalId, ['open', 'repairing']).map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        summary: e.summary,
        lastEventAtMs: e.lastEventAtMs,
    }));
    const tasks = repos.pendingTasks(input.binding.conversationId, 500).map((t) => ({
        id: String(t['id']),
        kind: String(t['kind']),
        content: String(t['content']),
        status: String(t['status']),
        dueAtMs: t['due_at_ms'] === null ? null : Number(t['due_at_ms']),
    }));
    const payload = {
        exportedAtMs: input.nowMs,
        companion: { id: config.companion.id, name: config.companion.name, preset: config.companion.preset },
        principalId: input.binding.principalId,
        affect: snapshot,
        memories,
        episodes,
        tasks,
    };
    const file = join(directory, `export-${input.binding.principalId}-${input.nowMs}.json`);
    try {
        writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    }
    catch (error) {
        return fail(`导出失败：${error.message}`);
    }
    return ok(`导出好了：${memories.length} 条记忆、${episodes.length} 段关系、${tasks.length} 个任务。\n文件：${file}`);
}
function commandDoctor(deps, input) {
    const { config, repos, db } = deps;
    const lines = [`自检 · ${config.companion.name}`];
    const migrations = migrationStatus(db);
    const pending = migrations.pending.length;
    const mismatch = migrations.checksumMismatch.length;
    lines.push(`迁移：当前版本 ${migrations.current}${pending > 0 ? ` · 待应用 ${pending}` : ''}${mismatch > 0 ? ` · 校验不符 ${mismatch}` : ''}`);
    const caps = db.capabilities();
    lines.push(`SQLite：${caps.sqliteVersion ?? 'unknown'} · FTS5 ${caps.fts5 ? '可用' : '不可用'}`);
    const report = deps.compatibility?.();
    if (report) {
        lines.push(describeCompatibility(report));
    }
    else {
        lines.push('宿主能力：未探测（离线模式）');
    }
    const backup = backupSummary(backupDirectory(db.file));
    lines.push(`备份：${backup.total} 份 · 最近 ${backup.latest ? fmtTime(backup.latest.createdAtMs, config.proactive.timezone) : '无'}`);
    if (deps.scheduler) {
        const s = deps.scheduler.status();
        lines.push(`调度器：${s.enabled ? '开' : '关'} · 下次 ${fmtTime(s.nextCheckAtMs, config.proactive.timezone)}`);
    }
    if (deps.backgroundStats) {
        const b = deps.backgroundStats();
        const pairs = Object.entries(b).map(([k, v]) => `${k} ${v}`);
        if (pairs.length > 0)
            lines.push(`后台任务：${pairs.join(' · ')}`);
    }
    const stuck = repos.unresolvedOutbox(input.binding.conversationId, input.nowMs - 24 * 3600_000);
    if (stuck.length > 0)
        lines.push(`⚠ 24 小时内有 ${stuck.length} 条投递未确认`);
    return ok(lines.join('\n'));
}
function safeJson(text) {
    if (typeof text !== 'string' || text === '')
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function hashText(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
/** 命令名表：index.ts 注册 /fish 时用来判断「这条要不要拦」。 */
export const FISH_COMMANDS = [
    'help',
    'review',
    'status',
    'mood',
    'why',
    'memory',
    'remember',
    'forget',
    'correct',
    'personality',
    'proactive',
    'reset',
    'export',
    'doctor',
];
export function looksLikeFishCommand(text) {
    const trimmed = text.trim();
    return /^\/?fish(\s|$)/iu.test(trimmed);
}
/** 从 `/fish xxx` 里剥出 `xxx`。 */
export function stripFishPrefix(text) {
    return text.trim().replace(/^\/?fish\s*/iu, '');
}
export { backupNow };
//# sourceMappingURL=handlers.js.map