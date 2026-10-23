# 安装

安装 = 让 profile 认得这个包（依赖 + bundle），重启桌面端。不修改宿主代码，不打包进 asar。

## 0. 前置

```powershell
cd Z:\deepseekharness\fiels\dsh-companion-memory
$env:ELECTRON_RUN_AS_NODE='1'
& 'Z:\dsh\DeepSeek Harness.exe' scripts\build.mjs      # 产出 lib/，类型检查不过会失败
& 'Z:\dsh\DeepSeek Harness.exe' scripts\doctor.mjs     # 只读自检，失败项会给出证据
```

`doctor` 里「数据库尚未创建」「尚无备份」是首次运行前的正常 WARN；`FAIL` 必须先修。

## 1. 让 profile 认识这个包

编辑 `C:\Users\29400\.dsh\profiles\desktop\package.json`，两处都要加：

```jsonc
{
  "dependencies": {
    "dsh-companion-memory": "link:Z:/deepseekharness/fiels/dsh-companion-memory"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // … 原有条目 …
        "dsh-companion-memory"
      ]
    }
  }
}
```

- 用 `link:` 而不是复制：以后改源码重新 `build` 即可生效，不用重装。
- `bundles` 里的名字必须与 `package.json` 的 `name` 一致。
- 包自带 `cordis.patch.yml`（顶层数组，`insert` 一行），bundle 层会自动把插件插进 loader。

> 也可以用插件市场/`plugin_manager` 安装（`install_bundle`，target 用同样的 `link:` 路径）；
> 手改 `package.json` 只是最不容易出错的等价做法。

## 2. 配置（可选但建议）

在 `C:\Users\29400\.dsh\profiles\desktop\cordis.patch.yml` 顶层加一行同 id 的行，
配置**放在这里**而不是包里的 patch（包内 patch 的 `config` 会被 compose 自检拒绝）：

```yaml
- id: dsh-companion-memory
  name: dsh-companion-memory
  config:
    companion:
      id: blue-fish-main
      name: 大肥鱼
      preset: irritable        # irritable | balanced | gentle
      scope: owner_private     # owner_private | owner_all
    channel:
      ownerChats: ["private:2940015320"]
      enabledGroupChats: []
      onebotHttpBase: http://127.0.0.1:3000
      chatSessionsFile: C:\Users\29400\.dsh\media\onebot\chat-sessions.json
    proactive:
      enabled: false           # 打开前先确认 ownerChats 与协议端都在
    generation:
      liveModelCalls: true
```

所有字段与默认值见 `src/config.ts` 的 `DEFAULT_CONFIG`。写错字段会在启动时抛
`ConfigError`（消息里带字段路径），不会静默用默认值顶替。

## 3. 重启并确认

重启 DSH Desktop 后：

1. `设置 → 插件` 应出现 `dsh-companion-memory`，且处于启用状态。
2. 宿主日志里应有一行 `[dsh-companion-memory] mounted …`（含能力探测结论与交付档位）。
3. 任意会话里执行 `/fish status`，应返回绑定信息、轮次与记忆计数。
4. `%USERPROFILE%\.dsh\companions\blue-fish-main.sqlite3` 被创建（首次真正收消息后）。

任一步不符，先跑 `scripts/doctor.mjs --json` 拿证据，再对照 `docs/ROLLBACK.md` 回滚。

## 4. QQ 侧（可选）

1. 装 `dsh-onebot-qq` 并配好协议端（NapCat / SnowLuma，HTTP 3000 / WS 3001）。
2. 把 QQ 会话写进 `channel.ownerChats`（格式 `private:<QQ号>` 或 `group:<群号>`）。
3. 群里使用时还要进 `enabledGroupChats`；不在白名单的会话不会触发伴侣行为。

## 升级

```powershell
& 'Z:\dsh\DeepSeek Harness.exe' scripts\build.mjs
```

`link:` 安装下重新构建即生效；重启桌面端让 loader 重新加载 `lib/`。
数据库迁移由插件启动时按版本号顺序应用，只前进不回退（回滚见 ROLLBACK）。
