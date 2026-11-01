# 换设备也能记住：记忆的自足性

这份文档只回答一个问题：**把 DSH 搬到另一台机器，记忆还完整吗，会不会又变成"记了个寂寞"。**

结论先说：记忆的权威只有一处——本机 SQLite。任何需要云端 token 才能写入的"记忆插件"
都不是这个插件的依赖，装上它只会每轮发一次 401，再往系统提示里塞几千字符的无关说明。

## 1. 记忆权威在哪

| 内容 | 位置 |
| --- | --- |
| 提炼后的记忆（`memories` / `memory_evidence`） | `<dshHome>/companions/<companion>.sqlite3` |
| 原文全文（`raw_messages`） | 同一个库 |
| 检索索引 | 同库 `memory_fts`（FTS5） |
| 每轮注入的短记忆 | 同库 → 渲染成 `MEMORY.md` / `USER.md` 的条目 |
| 日备份 | `<dshHome>/companions/backups/` |

`<dshHome>` 在 Windows 上默认是 `%USERPROFILE%\.dsh`，可由环境变量 `DSH_HOME` 覆盖。
库路径、备份路径、`chat-sessions.json` 路径全部由 `dshHome()` 推导（`src/config.ts`），
**没有一处写死用户名或盘符**。

搬家时把整个 `<dshHome>/companions/` 拷过去即可；新机器上的用户名、盘符、Node 版本都不影响。

## 2. 换设备会踩的两个坑

### 2.1 profile 把外部记忆插件带回来

`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 是一份**按名字挂载**的清单。
如果某台机器的清单里有 `@vectorize-io/hindsight-coding-agents`，而 `~/.hindsight/coding-agent.json`
里没有 `apiToken`，这个插件会：

- 每次写入/反思/翻页都向 `api.hindsight.vectorize.io` 发请求，稳定收到 `401 Authentication failed`；
- 与此同时仍然 `inject_ok`，往系统提示里注入约 3.2 KB 的工具说明。

本机实测：`diag.jsonl` 里累计 427 次 401，一次也没成功写入过记忆。也就是说它从未工作，
只是噪音。

### 2.2 配置里写死绝对路径

`cordis.patch.yml` 里如果出现

```yaml
- id: dsh-companion-memory
  chatSessionsFile: 'C:\Users\33544\.dsh\media\onebot\chat-sessions.json'
```

换到用户名为 `alice` 的机器后，这个路径指向不存在的文件，QQ 会话映射静默失效。
删掉这一行就会回落到 `join(dshHome(), 'media', 'onebot', 'chat-sessions.json')`——本机等价，
换机自动正确。

## 3. 一行修好

```bash
node scripts/fix-profile-memory.mjs
```

它做三件事，全部幂等，写前把原文件备份成 `<文件>.bak-memory-<时间戳>`：

1. 从 `dsh.profile.bundles` 摘掉外部记忆插件（`dependencies` 条目保留，不触发重装）；
2. 在 `cordis.patch.yml` 落一行 `- id: hindsight` + `disabled: true` 兜底——即使清单被别的
   设备或别的工具加回来，loader 也不会加载它；
3. 把写死的绝对路径 `chatSessionsFile` 注释掉，回落到 `dshHome()` 推导。

已经干净时什么都不写，退出码 0。想看它准备改什么：

```bash
node scripts/fix-profile-memory.mjs --dry-run
node scripts/fix-profile-memory.mjs --json     # 给脚本用
node scripts/fix-profile-memory.mjs --profile desktop --home D:\other-dsh
```

**改的是 profile 配置，需要完全退出并重启 DSH 桌面端才会重新加载 loader。**

## 4. 怎么确认真的干净

```bash
node scripts/doctor.mjs
```

第 8 项「记忆职责」逐条打印判定结果：

| code | 含义 | level |
| --- | --- | --- |
| `external-memory-absent` | bundles 里没有外部记忆插件 | ok |
| `external-memory-disabled` | 还在 bundles 里，但 loader 行已 `disabled: true` | ok |
| `external-memory-active` | 挂着且没禁用——会 401 | warn |
| `absolute-session-path` | `chatSessionsFile` 写死了绝对路径 | warn |
| `companion-row-missing` | patch 里没有本插件的顶层配置行 | warn |
| `patch-missing` / `profile-json` | 文件缺失或解析失败 | warn / fail |

doctor 是只读的，不会改任何文件；修复永远走第 3 节的脚本。

## 5. 新增一个需要凭据的外部记忆插件时

`scripts/profile-memory-guard.mjs` 顶部的表就是唯一登记处：

```js
export const EXTERNAL_MEMORY_BUNDLES = [
  { bundle: '@vectorize-io/hindsight-coding-agents', id: 'hindsight' },
]
```

加一条 `{ bundle, id }`，doctor 与修复脚本同时生效，不需要改别的代码。
`tests/unit/profile-memory-guard.test.mjs` 覆盖了摘除、兜底、幂等、备份、路径清理、
以及 JSON 尾随逗号修复这几条路径。

## 6. 自足性检查清单

搬完机器，按顺序过一遍：

- [ ] `<dshHome>/companions/*.sqlite3` 已拷过去，`node scripts/doctor.mjs` 的「完整性检查」是 `ok`
- [ ] 「记忆条数」「原文条数」与旧机一致（迁移只追加，不会因为换机丢行）
- [ ] 「记忆职责」是 `external-memory-absent` 或 `external-memory-disabled`
- [ ] `node scripts/fix-profile-memory.mjs --dry-run` 输出「没有需要修的项目」
- [ ] 环境里没有残留的 `HINDSIGHT_*` / `VECTORIZE_*` 变量（有也不影响，插件不加载了）
- [ ] 完全退出并重启 DSH 桌面端，`/fish status` 正常
