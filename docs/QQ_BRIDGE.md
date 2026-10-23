# QQ 桥接入与回滚

支持 `dsh-onebot-qq@0.9.3`。补丁保留原来的连接、本人权限、入站去重、普通回复发送管线及其他用户路径；不启动第二个机器人。

`/fish` 在原命令拦截器前分发。本人普通纯文本由陪伴服务处理，已消费时不再启动原 Agent 回合；unknown 回执也不会触发原路径重发。媒体、引用、转发、群聊及其他用户保留原桥处理。

## 检查与副本验证

使用 Node >=22.13，或者以下本机已验证的运行时：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$runtime = 'Z:\dsh\DeepSeek Harness.exe'
$bridge = 'C:\Users\29400\.dsh\profiles\desktop\node_modules\dsh-onebot-qq'
& $runtime scripts\patch-qq-bridge.mjs --target $bridge
& $runtime scripts\verify-qq-bridge.mjs --target $bridge
```

第一条只检查版本和唯一源码锚点，不写文件。第二条仅操作临时副本，验证语法、入站分发和回滚，不联网、不发送消息。任一检查失败即停止安装，不能跳过版本检查。

## 应用

先保存并正常退出目标 DSH 实例，再执行：

```powershell
& $runtime scripts\patch-qq-bridge.mjs --target $bridge --apply
```

原始文件与 SHA-256 清单保存在桥包的 `.companion-patch/`。应用过程失败会恢复原文件。重新启动目标 DSH；不要额外启动一个占用同一 OneBot 连接的实例。

配置本人 `channel.ownerChats: ["private:<本人QQ>"]`，按 `INSTALL.md` 安装本插件，再在本人私聊检查 `/fish status`。未知会话不启用陪伴功能；没有有效机器人身份的入站不进入新路径。真实联调应使用少量必要消息，不能将副本测试当作真实 QQ 验收。

## 回滚

停止目标实例后执行：

```powershell
& $runtime scripts\patch-qq-bridge.mjs --target $bridge --revert
```

回滚先检查现文件和备份 checksum；桥包后来被其他修改或升级时拒绝覆盖。移除本插件后，已补丁的桥也会在服务缺失时回落原有路径；正式卸载仍建议回滚补丁。陪伴数据库保持在用户数据目录，回滚桥代码不会删除它。
