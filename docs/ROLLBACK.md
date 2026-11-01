# 回滚与卸载

三种粒度，从轻到重。**任何一步都不会删除数据库**，记忆数据始终保留在
`%USERPROFILE%\.dsh\companions\<companion-id>.sqlite3`。

## 1. 只停用（推荐日常用）

`设置 → 插件` 里关掉 `dsh-companion-memory`，或在 profile 的 `cordis.patch.yml` 顶层加：

```yaml
- id: dsh-companion-memory
  name: dsh-companion-memory
  disabled: true
```

停用后：定时器（主动扫描、后台队列）停止、提示词 section 撤掉、命令不再注册、
QQ 桥收到的消息不再进这个插件。数据库与备份原地保留，重新启用即恢复。

## 2. 从 profile 摘掉（不再加载代码）

编辑 `C:\Users\29400\.dsh\profiles\desktop\package.json`：

1. `dependencies` 里删掉 `"dsh-companion-memory": "link:…"`；
2. `dsh.profile.bundles` 里删掉 `"dsh-companion-memory"`。

然后重启桌面端。`link:` 依赖不会复制文件，删掉依赖即可，源码目录可以留着也可以删。

## 3. 彻底清理（含数据）

```powershell
# 先备份，再删
Copy-Item "$env:USERPROFILE\.dsh\companions\blue-fish-main.sqlite3" "$env:USERPROFILE\Desktop\companion-backup.sqlite3"
Remove-Item "$env:USERPROFILE\.dsh\companions\blue-fish-main.sqlite3" -Force
Remove-Item "$env:USERPROFILE\.dsh\companions\backups" -Recurse -Force
```

源码目录 `Z:\deepseekharness\fiels\dsh-companion-memory` 可直接删除。

## 恢复

1. 完全退出宿主，保留当前数据库；不要直接用旧备份覆盖它。
2. 将 `DSH_COMPANION_CONFIG` 指向所需的 JSON 配置（含目标 `storage.directory` 和 `companion.id`），运行：

   ```powershell
   node scripts/companionctl.mjs restore <backup.sqlite3> --offline-confirm
   ```

   CLI 先在临时副本上检查完整性和迁移，合入当前库的删除记录，重放原文与记忆删除、撤销派生习惯及情感事件，直接重建受影响的情感快照和全文索引。验证成功后，另存覆盖前备份，再替换已关闭的目标库。不同或未知 owner、身份冲突及损坏备份会拒绝恢复。
3. 重新启用插件，再运行 `node scripts/doctor.mjs` 检查完整性和迁移状态。

此流程依赖当前库或备份中尚存的 tombstone。若当前库已经丢失、且旧备份没有较新的删除记录，仅凭这份旧备份无法推断后来删除了什么。覆盖前备份本身也可能含历史原文，仍遵循原有备份保留期限。

数据库迁移只前进不回退：如果备份来自**更新**的版本而当前插件是**旧**版本，
启动会因迁移版本高于代码预期而报错，此时要么升级插件，要么用备份前的旧库。

## 出问题时的取证顺序

1. `node scripts/doctor.mjs --json`（只读，最快定位：配置/文件/完整性/积压）；
2. 宿主日志里搜 `[dsh-companion-memory]`，看挂载时的能力探测结论；
3. 需要复现行为时跑 `node scripts/replay.mjs --turns 200`，它用临时库，不碰真实数据。
