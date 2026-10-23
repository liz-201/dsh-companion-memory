/**
* 离线运维 CLI（任务书 §15.2）。 *
* 约束来自任务书，逐条落地：
*   · 只读优先：doctor / inspect / export / bench 都不改库；
*   · 写操作（backup 是拷贝、restore 是覆盖）必须由用户显式触发，
*     且 restore 在**宿主可能正在跑**的情况下默认拒绝——宁可让用户先停应用，
*     也不能在运行时把库换掉（那会「偷走」宿主的内存状态与未提交事务）；
*   · 从不删除备份，从不原地改写 memories 的语义。 * * 用法：
*   node src/commands/offline-cli.js doctor
*   node src/commands/offline-cli.js inspect [--principal <id>]
*   node src/commands/offline-cli.js export --out <file> *   node src/commands/offline-cli.js backup
*   node src/commands/offline-cli.js restore <file> --offline-confirm *   node src/commands/offline-cli.js bench */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveConfig } from '../config.js';
import { databaseExists, databaseFile, openDatabase } from '../storage/database.js';
import { migrationStatus } from '../storage/migrations.js';
import { Repositories } from '../storage/repositories.js';
import { backupNow, backupSummary } from '../storage/backup.js';
import { summarizeState, projectSnapshot } from '../domain/affect-reducer.js';
const defaultIo = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
};
function loadConfig() {
    const path = process.env['DSH_COMPANION_CONFIG'];
    if (!path)
        return resolveConfig();
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        return resolveConfig(raw);
    }
    catch (error) {
        throw new Error(`读不了配置文件 ${path}：${error.message}`);
    }
}
function argValue(argv, name) {
    const index = argv.indexOf(`--${name}`);
    if (index < 0)
        return undefined;
    return argv[index + 1];
}
function hasFlag(argv, name) {
    return argv.includes(`--${name}`);
}
export function main(argv, io = defaultIo) {
    const [command = 'help', ...rest] = argv;
    let config;
    try {
        config = loadConfig();
    }
    catch (error) {
        io.err(error.message);
        return 2;
    }
    const file = databaseFile(config.storage.directory, config.companion.id);
    if (!databaseExists(file)) {
        io.err(`数据库不存在：${file}\n先启动一次应用，或确认 storage.directory 配置。`);
        return 3;
    }
    switch (command) {
        case 'help':
            io.out(HELP);
            return 0;
        case 'doctor':
            return commandDoctor(config, file, io);
        case 'inspect':
            return commandInspect(config, rest, io);
        case 'export':
            return commandExport(config, rest, io);
        case 'backup':
            return commandBackup(config, file, io);
        case 'restore':
            return commandRestore(config, file, rest, io);
        case 'bench':
            return commandBench(config, io);
        default:
            io.err(`没有 ${command} 这个子命令。\n${HELP}`);
            return 2;
    }
}
const HELP = [
    'companionctl（离线运维）',
    '  doctor                    自检：迁移、能力、备份、计数',
    '  inspect [--principal id]  查看关系状态与最近记忆（只读）',
    '  export --out <file>       导出记忆与状态 JSON（只读）',
    '  backup                    立刻做一次备份',
    '  restore <file> --offline-confirm  用备份覆盖当前库（必须先停应用）',
    '  bench                     汇总 artifacts/benchmarks 的最近结果（只读）',
].join('\n');
function commandDoctor(config, file, io) {
    const db = openDatabase(config.storage, false, config.companion.id);
    try {
        const migrations = migrationStatus(db);
        const caps = db.capabilities();
        const repos = new Repositories(db);
        const counts = repos.counts();
        const backups = backupSummary(dirname(file) ? join(dirname(file), 'backups') : 'backups');
        io.out(`companion: ${config.companion.name} (${config.companion.id})`);
        io.out(`database: ${file}`);
        io.out(`sqlite: ${caps.sqliteVersion} · fts5=${caps.fts5} · json1=${caps.json1} · wal=${caps.wal}`);
        io.out(`migrations: current=${migrations.current} pending=${migrations.pending.length} mismatch=${migrations.checksumMismatch.length}`);
        io.out(`tables: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        io.out(`backups: total=${backups.total} bytes=${backups.bytes}`);
        if (backups.latest)
            io.out(`latest backup: ${backups.latest.file}`);
        if (migrations.pending.length > 0) {
            io.out('注意：有未应用的迁移，启动应用时会自动应用。');
        }
        return 0;
    }
    finally {
        db.close();
    }
}
function commandInspect(config, argv, io) {
    const db = openDatabase(config.storage, false, config.companion.id);
    try {
        const repos = new Repositories(db);
        const principalId = argValue(argv, 'principal');
        if (!principalId) {
            const row = db.get('SELECT id FROM principals ORDER BY rowid LIMIT 1');
            if (!row) {
                io.out('库里还没有 principal（应用还没跑过一轮对话）。');
                return 0;
            }
            return printPrincipal(repos, config, row.id, io);
        }
        return printPrincipal(repos, config, principalId, io);
    }
    finally {
        db.close();
    }
}
function printPrincipal(repos, config, principalId, io) {
    const stored = repos.getSnapshot(principalId);
    if (!stored) {
        io.out(`principal ${principalId} 还没有情感快照。`);
        return 0;
    }
    const snapshot = projectSnapshot(stored.snapshot, Date.now(), config.affect);
    const summary = summarizeState(snapshot);
    io.out(`principal: ${principalId} · revision=${stored.revision}`);
    io.out(`relationship: ${summary.relationshipLevels}`);
    io.out(`mood: ${summary.moodLevels}`);
    if (summary.episodeHint)
        io.out(`episode: ${summary.episodeHint}`);
    const episodes = repos.listEpisodes(principalId, ['open', 'repairing'], 5);
    if (episodes.length > 0) {
        io.out('open episodes:');
        for (const e of episodes)
            io.out(`  - ${e.kind} (${e.status}) ${e.summary}`);
    }
    const memories = repos.allMemories(principalId, 10);
    if (memories.length > 0) {
        io.out('recent memories:');
        for (const m of memories)
            io.out(`  - [${m.kind}] ${m.claim}`);
    }
    return 0;
}
function commandExport(config, argv, io) {
    const out = argValue(argv, 'out');
    if (!out) {
        io.err('用法：export --out <file>');
        return 2;
    }
    const db = openDatabase(config.storage, false, config.companion.id);
    try {
        const repos = new Repositories(db);
        const principals = db.all('SELECT id FROM principals ORDER BY rowid');
        const payload = {
            exportedAtMs: Date.now(),
            companion: {
                id: config.companion.id, name: config.companion.name
            },
            principals: principals.map((p) => ({
                id: p.id,
                snapshot: repos.getSnapshot(p.id)?.snapshot ?? null,
                episodes: repos.listEpisodes(p.id, ['open', 'repairing', 'resolved', 'archived'], 1000),
                memories: repos.allMemories(p.id, 100000).map((m) => ({
                    id: m.id,
                    kind: m.kind,
                    claim: m.claim,
                    confidence: m.confidence,
                    salience: m.salience,
                    observedAtMs: m.observed_at_ms,
                })),
            })),
        };
        const target = resolve(out);
        mkdirSync(dirname(target), {
            recursive: true
        });
        writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
        io.out(`已导出：${target}`);
        return 0;
    }
    finally {
        db.close();
    }
}
function commandBackup(config, file, io) {
    const db = openDatabase(config.storage, false, config.companion.id);
    try {
        const directory = join(dirname(file), 'backups');
        const record = backupNow(db, {
            directory, keepDays: config.storage.backupRetentionDays, label: config.companion.id
        }, Date.now());
        io.out(`备份完成：${record.file}（${record.bytes} 字节）`);
        return 0;
    }
    finally {
        db.close();
    }
}
function commandRestore(config, file, argv, io) {
    const source = argv.find((a) => !a.startsWith('--'));
    if (!source) {
        io.err('用法：restore <backup file> --offline-confirm');
        return 2;
    }
    const sourcePath = resolve(source);
    if (!existsSync(sourcePath)) {
        io.err(`备份文件不存在：${sourcePath}`);
        return 2;
    }
    if (!hasFlag(argv, 'offline-confirm')) {
        io.err([
            '拒绝直接覆盖：宿主可能正在使用这个库，运行中换库会让应用状态和磁盘不一致。', '正确流程：',
            '  1) 完全退出 DSH 桌面端；',
            '  2) 重新执行并带上 --offline-confirm。',
            `  node src/commands/offline-cli.js restore "${sourcePath}" --offline-confirm`,
        ].join('\n'));
        return 4;
    }
    const directory = join(dirname(file), 'backups');
    const handle = openDatabase(config.storage, false, config.companion.id);
    let record;
    try {
        record = backupNow(handle, {
            directory, keepDays: config.storage.backupRetentionDays, label: `${config.companion.id}-pre-restore`
        }, Date.now());
    }
    finally {
        handle.close();
    }
    io.out(`覆盖前已另存：${record.file}`);
    try {
        const bytes = readFileSync(sourcePath);
        writeFileSync(file, bytes);
    }
    catch (error) {
        io.err(`恢复失败：${error.message}`);
        return 5;
    }
    io.out(`已用 ${sourcePath} 覆盖 ${file}`);
    return 0;
}
function commandBench(config, io) {
    const directory = resolve('artifacts', 'benchmarks');
    if (!existsSync(directory)) {
        io.out(`没有基准结果目录：${directory}`);
        return 0;
    }
    const files = listJson(directory);
    if (files.length === 0) {
        io.out(`目录里还没有结果文件：${directory}`);
        return 0;
    }
    for (const name of files) {
        io.out(`- ${name}`);
    }
    io.out(`共 ${files.length} 份，目录 ${directory}`);
    io.out(`companion=${config.companion.id}`);
    return 0;
}
function listJson(directory) {
    try {
        return readdirSync(directory)
            .filter((name) => name.endsWith('.json')).sort();
    }
    catch {
        return [];
    }
}
/** 从 bin 入口调用时才会执行。 */
export function runFromProcess() {
    const code = main(process.argv.slice(2));
    process.exitCode = code;
}
//# sourceMappingURL=offline-cli.js.map