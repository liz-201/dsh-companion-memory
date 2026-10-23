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

1. 把备份文件放回 `%USERPROFILE%\.dsh\companions\<companion-id>.sqlite3`；
2. 重新启用插件；
3. 跑 `node scripts/doctor.mjs`，`完整性检查 = ok`、`迁移版本` 与备份时一致即恢复成功。

数据库迁移只前进不回退：如果备份来自**更新**的版本而当前插件是**旧**版本，
启动会因迁移版本高于代码预期而报错，此时要么升级插件，要么用备份前的旧库。

## 出问题时的取证顺序

1. `node scripts/doctor.mjs --json`（只读，最快定位：配置/文件/完整性/积压）；
2. 宿主日志里搜 `[dsh-companion-memory]`，看挂载时的能力探测结论；
3. 需要复现行为时跑 `node scripts/replay.mjs --turns 200`，它用临时库，不碰真实数据。
