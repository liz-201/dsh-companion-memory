# 0.3.0-dev.4 使用与回退

dev.4 新增完整记忆文件下载/上传、百度设备授权与令牌刷新、导出后自动上传、启动检查云端并合并、按设备分离快照和上传回读校验。通过 `/fish files` 使用，详见[网盘同步](../../CLOUD_MEMORY_SYNC.md)。账号授权与真实服务验证仍须单独记录。

dev.3 补齐长任务续租与旧执行者回写保护、桥接历史分页及准确任务结算、无主题情景记忆的身份区分、部分整理游标的来源边界、无共同祖先/旧导出回执的诊断和兼容处理，以及 COMMIT 失败后的事务恢复。当时全量 190 项通过。代码层测试不代替真机签收。

2026-10-25 的 dev.2 修复整理输出兼容与有限降级、孤儿租约恢复、同步 checkpoint 有界保留，以及普通待续任务的主动联系限流。配置新增 storage.syncIntervalSeconds，默认 300 秒。portable 格式和迁移文件未变；构建后需重载插件或重启 DSH。参见[同步说明](../../SYNC.md)。

这是尚未完成全部质量验收的开发版。当前桌面profile的插件目录以junction指向本仓库；构建产物已更新，DSH需要重启/重新加载插件才使用新代码。研发过程没有自动重启用户应用。

默认enforce模式启用表达管线；沿用已有角色与记忆。命令示例：

```text
/fish personality show
/fish personality mix gentle=.45 earnest=.35 playful=.20
/fish personality set reserve=.65
/fish habits list
/fish expression why
/fish proactive why
/fish proactive pause
/fish proactive resume
/fish proactive device take
```

mix/set作用当前角色，正常切回其他角色时不会串用关系和习惯。主动联系默认有静默、间隔、日限及未回复暂停；没有具体话题就不发送。DSH关闭时插件不运行；启动后本地主动目标需要本次运行已观察到的真实用户会话，不向全部历史会话广播。

只有显式配置proactive.shareSources里的HTTPS来源才会读取外部内容；默认空数组。读取失败就放弃该来源，不编造替代见闻。对未配置来源的用户，仍可使用真实待续话题和事件回访。

升级已有库且migrationMode为默认backup_then_migrate时，会在backups中生成带pre-v03标记的一致性备份，再执行005–007。迁移失败整批回滚。新的迁移不会修改001–004的文件或checksum。

回退时先退出DSH，保留当前库、备份和transfer目录；使用升级前的一致性备份与原0.2.0包恢复。不要让旧版直接消费v2导出文件，也不要覆盖还在使用的WAL主库。旧版暂存包位于dist/dsh-companion-memory-0.2.0。回退操作需保留升级后新记忆副本，不能假装旧备份含有新数据。

模型改写的语义保持、中文自然度和主动时机仍须通过正式评测；开发版的单元测试结果不能作为“已经像真人”的承诺。

## 真实模型对比入口

`scripts/evaluate-expression.mjs`支持baseline（原0.2.0运行时）、prompt（原运行时加核心表达提示）与full（当前实际协调器，包括检查/修复）。全部在内存库和假投递器中执行，不给真实会话发测试消息。

live模式需显式提供本地adapter模块：导出`metadata={provider,model,version,temperature}`，以及异步`generate({system,user,maxTokens,seed,phase})`返回`{text,usage?}`。adapter自行接用户选定的模型入口，报告不写凭据。没有adapter时只允许fake，不把脚本输出写成真实质量结论。

```powershell
node scripts/evaluate-expression.mjs --mode=live --variant=baseline --split=acceptance --max-calls=240 --adapter=./model-adapter.mjs --output=artifacts/baseline-live.json
node scripts/evaluate-expression.mjs --mode=live --variant=prompt --split=acceptance --max-calls=240 --adapter=./model-adapter.mjs --output=artifacts/prompt-live.json
node scripts/evaluate-expression.mjs --mode=live --variant=full --split=acceptance --max-calls=240 --adapter=./model-adapter.mjs --output=artifacts/full-live.json
node scripts/prepare-blind-review.mjs --baseline=artifacts/baseline-live.json --prompt=artifacts/prompt-live.json --full=artifacts/full-live.json
```

原版目录默认dist/dsh-companion-memory-0.2.0，可用`--baseline-root`指定已保存的版本。max-calls包括修复调用；预算耗尽可能导致不足180例，盲评工具会拒绝不完整数据。先人工审核语料，再执行live；不要把以上命令当成已经执行过的记录。三名评审独立填写CSV，保留answer-key至评分结束后再揭盲；工具不会自动填真人评分。四项消融和多日真实试用仍需按验收方案执行。
