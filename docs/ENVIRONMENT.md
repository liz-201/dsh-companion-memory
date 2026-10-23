# 环境（实测）

记录构建与验收时的真实环境。换机器后请重跑 `scripts/doctor.mjs`，以它的输出为准。

## 本机

| 项 | 值 | 来源 |
| --- | --- | --- |
| OS | Windows 10/11 x64（`process.platform = win32`） | `node -p process.platform` |
| DSH Desktop | 0.2.1-rc.2 | `Z:\dsh\resources\runtime\runtime.json` |
| DSH 安装根 | `Z:\dsh\DeepSeek Harness.exe` | 桌面端安装目录 |
| Node（宿主内置） | 24.21.0 | `ELECTRON_RUN_AS_NODE=1` 后 `process.versions.node` |
| Node（PATH 上） | 14.21.3 | 仅作参考，**不要用它跑构建**（无 `node:sqlite`） |
| SQLite | `node:sqlite` 内置（DatabaseSync） | `import('node:sqlite')` 可用 |
| FTS5 | 可用 | `migrate()` 建 `memories_fts` 成功 |
| TypeScript | 5.9.3（随仓库 vendored） | `_vendor/typescript/lib/tsc.js` |
| DSH profile | `C:\Users\29400\.dsh\profiles\desktop` | 桌面端当前 profile |

## 为什么用 Electron 内置 Node 跑脚本

本插件零原生依赖，靠 `node:sqlite`。PATH 上的 Node 14 没有它，`npx`/`npm` 也不在 PATH 上。
所有构建、测试、脚本都通过下面这一行执行：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'Z:\dsh\DeepSeek Harness.exe' scripts\build.mjs
```

`scripts/build.mjs` 内部用 `spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'])`，
所以不管从哪个 Node 启动，编译都跑在同一个解释器上，不需要额外配置。

## 目录约定

| 路径 | 作用 |
| --- | --- |
| `src/` | TypeScript 源码（36 个文件） |
| `lib/` | 编译产物（108 个 `.js`/`.d.ts`/`.map`）；`package.json` 的 `main` 指向 `src/index.js` |
| `prompts/` | 人设与协议提示词（运行时按文件读取，缺失会让 doctor 报 FAIL） |
| `migrations/` | `001_initial.sql`（表与索引）、`002_fts.sql`（FTS5） |
| `tests/unit/` `tests/integration/` | 单元与挂载集成测试 |
| `scripts/` | build / doctor / benchmark / replay / package |
| `artifacts/` | 测试与基准的原始输出（验收证据） |
| 数据库 | `%USERPROFILE%\.dsh\companions\<companion-id>.sqlite3`（默认 companion-id `blue-fish-main`） |
| 备份 | 与数据库同目录的 `backups/` |

## 构建与校验

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$node = 'Z:\dsh\DeepSeek Harness.exe'
& $node scripts\build.mjs               # 类型检查 + 输出 lib/
& $node scripts\build.mjs --check-only  # 只类型检查
& $node scripts\build.mjs --clean       # 清空 lib/ 再编译
```

`tsconfig.json` 打开 `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals/Parameters`、
`exactOptionalPropertyTypes` 相关严格项；类型检查不通过就不会产出 `lib/`。
