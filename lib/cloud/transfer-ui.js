import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PortableImportError } from '../storage/portable.js';
import { OwnerMergeInputError } from '../storage/owner-merge.js';
import { panelStyle, panelSections, panelScript } from '../panel/page.js';
import { ConfigError } from '../config.js';
import { PanelInputError } from '../panel/errors.js';
const html = (token, fullPanel) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>情感记忆插件 · 控制台</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 24px;color:#233044;background:#f6f8fb}section{background:white;border:1px solid #dde3ed;border-radius:14px;padding:22px;margin:20px 0}h1{font-size:28px}h2{font-size:19px;margin-top:0}button,a.button{font:inherit;background:#245fca;color:white;border:0;border-radius:7px;padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block;margin:5px 8px 5px 0}button.secondary{background:#e7edf6;color:#233044}input{font:inherit;display:block;width:95%;padding:9px;margin:7px 0 14px;border:1px solid #bbc7d9;border-radius:6px}small{color:#58677d}#message{white-space:pre-wrap}button:disabled{opacity:.5;cursor:wait}.status{white-space:pre-wrap;font-size:14px}label{display:block}</style>
<style>${fullPanel ? panelStyle : ''}</style><h1>情感记忆 · 插件控制台</h1><p>记忆管理、性格与情绪、主动联系和同步。${fullPanel ? '在这里查看并操作插件的全部功能。' : '连接百度网盘后，打开 DSH 会自动检查云端并合并记忆。'}</p>
${fullPanel ? panelSections : ''}
<section id="files-panel"><h2>记忆文件</h2><button id="export">导出并下载记忆</button><label>导入记忆文件<input id="file" type="file" accept=".json,.companion.json"></label><button id="import">导入所选记忆</button><p><small>导入前自动备份，保留双方新增内容与冲突记录。不会覆盖当前插件程序，也不会重发旧的待发消息。</small></p><span id="download"></span></section>
<section id="owner-merge-panel"><h2>两台已有记忆首次配对</h2><p>两台电脑都是你在使用，而且两边都有重要记忆时，在这里预览合并。选择另一台导出的记忆文件，或读取网盘中被身份保护拦住的记忆。先等对话生成和后台整理结束，再确认合并。</p><button id="merge-file">预览所选文件的合并</button><button id="merge-cloud" class="secondary">预览网盘中的待配对记忆</button><pre id="merge-preview" class="status"></pre><div id="merge-confirmation" hidden><p>合并会保留双方历史，采用来源记忆的主人身份；操作前自动备份。旧的“全部忘记”只作用于当时已记录的内容。情感按历史重建，不将两份好感度相加。</p><label><input id="merge-same-person" type="checkbox" style="display:inline;width:auto">我确认两份记忆属于同一个人</label><label>输入“同一个人”确认<input id="merge-words" autocomplete="off"></label><button id="merge-confirm">备份并合并双方记忆</button></div><p><small>有同一 ID 对应不同原文等严重冲突时，会保留两份原始库并停止自动合并。不要清空任一端。配对成功后，在两台电脑依次点“立即同步”。</small></p></section>
<section id="cloud-panel"><h2>百度网盘</h2><p id="cloud-state">正在读取状态…</p><button id="sync">立即同步</button><button id="disconnect" class="secondary">断开网盘</button><details><summary>首次连接或更换应用</summary><p><small>填写你在百度网盘开放平台创建的应用信息。授权只在百度官方页面完成。</small></p><label>AppKey<input id="appKey" autocomplete="off"></label><label>SecretKey<input id="secretKey" type="password" autocomplete="off"></label><label>应用目录名<input id="appFolder" placeholder="网盘 /apps/ 下该应用的目录名" autocomplete="off"></label><button id="connect">连接百度网盘</button><div id="authorize"></div><button id="finish" hidden>我已完成百度授权</button></details><p><small>连接成功后自动同步；导出记忆也会安排上传。每台电脑分别保存快照，离线期间的修改会在下次同步时合并。</small></p></section>
<section><h2>运行状态</h2><div id="status" class="status"></div><p id="message" role="status" aria-live="polite"></p></section>
<script>const token=${JSON.stringify(token)}, base='/companion-memory/api/', $=id=>document.getElementById(id);let working=false,panelRefresh=null,mergePreview=null;
async function request(action,body,raw=false){const r=await fetch(base+action,{method:body===undefined?'GET':'POST',headers:{'x-companion-token':token,...(body===undefined?{}:{'content-type':raw?'application/octet-stream':'application/json'})},body:body===undefined?undefined:raw?body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'操作未完成');return v}
function describe(s){$('cloud-state').textContent=s.connected?(s.enabled?'百度网盘已连接，自动同步已开启':'百度网盘已连接，自动同步已暂停'):'尚未连接百度网盘';$('status').textContent='同步状态：'+(s.busy?'进行中':s.error?'需要处理':'空闲')+'\\n上次成功同步：'+(s.lastSyncAtMs?new Date(s.lastSyncAtMs).toLocaleString():'尚无')+'\\n本次运行导入文件：'+s.imported+'；冲突：'+s.conflicts+(s.lineageMissing?'\\n部分文件缺少共同历史，已保留冲突供核对。':'')+(s.error?'\\n'+s.error:'')}
async function refresh(){try{describe(await request('status'));if(panelRefresh)await panelRefresh()}catch(e){$('message').textContent=e.message}}
async function run(fn){if(working)return;working=true;try{$('message').textContent='正在处理…';await fn()}catch(e){$('message').textContent=e.message}finally{working=false;await refresh()}}
$('export').onclick=()=>run(async()=>{const v=await request('export',{});const a=document.createElement('a');a.href=v.download;a.textContent='下载记忆文件';a.className='button';a.download=v.name;$('download').replaceChildren(a);a.click();$('message').textContent=v.upload==='queued'?'记忆已导出，已安排上传；可在运行状态查看同步结果。':'记忆已导出。连接百度网盘后可自动上传。'});
$('import').onclick=()=>run(async()=>{const f=$('file').files[0];if(!f)throw Error('请先选择记忆文件');if(f.size>536870912)throw Error('记忆文件超过大小限制');const r=await request('import',await f.arrayBuffer(),true);$('message').textContent='导入完成：新增 '+r.inserted+'，更新 '+r.updated+'，冲突 '+r.conflicts+(r.alreadyImported?'（该文件已处理）':'')+(r.lineageMissing?'。部分历史缺少共同祖先，已保留差异。':'');});
function showMerge(p){mergePreview=p;$('merge-same-person').checked=false;$('merge-words').value='';const r=p.report;$('merge-preview').textContent='本机：'+p.local.messages+' 条消息、'+p.local.memories+' 条记忆、'+p.local.affectEvents+' 条情感事件\\n来源：'+p.remote.messages+' 条消息、'+p.remote.memories+' 条记忆、'+p.remote.affectEvents+' 条情感事件'+(r?'\\n预计新增 '+r.inserted+'，更新 '+r.updated+'，删除 '+r.deleted+'，需核对冲突 '+r.conflicts:'')+(p.blockingConflicts.length?'\\n停止自动合并：'+p.blockingConflicts.map(c=>c.table+' / '+c.id+'：'+c.reason).join('\\n'):'\\n预览不会改动记忆。确认前如有新聊天，请重新预览。');$('merge-confirmation').hidden=p.blockingConflicts.length>0||!r;$('message').textContent='请核对来源和数量，再确认是否属于同一个人。'}
$('merge-file').onclick=()=>run(async()=>{const f=$('file').files[0];if(!f)throw Error('请先在记忆文件区选择另一台导出的文件');if(f.size>536870912)throw Error('记忆文件超过大小限制');showMerge(await request('merge-preview',await f.arrayBuffer(),true));});
$('merge-cloud').onclick=()=>run(async()=>showMerge(await request('merge-cloud-preview',{})));
$('merge-confirm').onclick=()=>run(async()=>{if(!mergePreview||!$('merge-same-person').checked||$('merge-words').value.trim()!=='同一个人')throw Error('请确认两份记忆属于同一个人，并输入“同一个人”。');const r=await request('merge-confirm',{previewToken:mergePreview.previewToken,confirmation:'same-owner-keep-both'});mergePreview=null;$('merge-confirmation').hidden=true;$('merge-preview').textContent='合并完成：新增 '+r.inserted+'，更新 '+r.updated+'，冲突 '+r.conflicts+'。\\n本机合并前备份：'+(r.backup||'内存测试库')+'\\n来源原件：'+r.sourceArchive;$('message').textContent=r.conflicts?'双方历史已保留，但仍有 '+r.conflicts+' 项差异需核对，不能视为完全一致。':'双方历史已合并。请在本机和另一台依次点击“立即同步”。';});
$('connect').onclick=()=>run(async()=>{const v=await request('connect',{appKey:$('appKey').value,secretKey:$('secretKey').value,appFolder:$('appFolder').value});$('secretKey').value='';const a=document.createElement('a');a.href=v.verificationUrl;a.target='_blank';a.rel='noopener noreferrer';a.textContent='打开百度官方授权页';a.className='button';const p=document.createElement('p');p.textContent='授权码：'+v.userCode;$('authorize').replaceChildren(a,p);$('finish').hidden=false;$('message').textContent='请在百度官方页面登录并授权，然后点击“我已完成百度授权”。';});
$('finish').onclick=()=>run(async()=>{const s=await request('authorize',{});describe(s);$('finish').hidden=true;$('authorize').replaceChildren();$('message').textContent=s.error||'授权成功，已执行首次同步。'});
$('sync').onclick=()=>run(async()=>{const s=await request('sync',{});describe(s);$('message').textContent=s.error||(s.enabled?'同步完成。':'请先连接百度网盘。')});
$('disconnect').onclick=()=>run(async()=>{await request('disconnect',{});$('message').textContent='已断开。本地记忆和云端已有文件均保留。'});${fullPanel ? panelScript + '\npanelRefresh=refreshPanel;' : ''}refresh();setInterval(refresh,5000);</script></html>`;
/** Loopback UI with an unguessable same-origin action token; no CORS/credential echo. */
export function createTransferHandler(transfer, controls) {
    const token = randomUUID() + randomUUID();
    const downloads = new Map();
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'" };
    return async (request, response) => {
        const send = (code, value) => { response.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
        const remote = request.socket?.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) {
            send(403, { error: '仅限本机访问。' });
            return;
        }
        let url;
        try {
            url = new URL(request.url ?? '/', `http://${request.headers.host}`);
        }
        catch {
            send(400, { error: '地址无效。' });
            return;
        }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            send(403, { error: '仅限本机地址。' });
            return;
        }
        if (url.pathname === '/companion-memory/manage' && request.method === 'GET') {
            response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
            response.end(html(token, !!controls));
            return;
        }
        if (!url.pathname.startsWith('/companion-memory/api/')) {
            send(404, { error: '页面不存在。' });
            return;
        }
        const provided = request.headers['x-companion-token'] ?? url.searchParams.get('token');
        if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
            send(403, { error: '请重新打开记忆管理页。' });
            return;
        }
        const origin = request.headers.origin;
        if (origin && origin !== url.origin) {
            send(403, { error: '请求来源无效。' });
            return;
        }
        const action = url.pathname.slice('/companion-memory/api/'.length);
        try {
            if (request.method === 'GET' && action === 'status') {
                send(200, transfer.status());
                return;
            }
            if (request.method === 'GET' && action === 'panel' && controls) {
                await transfer.ready;
                send(200, controls.snapshot({ conversationId: url.searchParams.get('conversationId') || undefined, query: url.searchParams.get('query') || undefined }));
                return;
            }
            if (request.method === 'GET' && action === 'download') {
                const file = downloads.get(url.searchParams.get('id') ?? '');
                if (!file) {
                    send(404, { error: '请重新导出记忆文件。' });
                    return;
                }
                response.writeHead(200, { ...headers, 'content-type': 'application/json', 'content-disposition': `attachment; filename="${basename(file)}"` });
                response.end(readFileSync(file));
                return;
            }
            if (request.method !== 'POST') {
                send(405, { error: '不支持的操作。' });
                return;
            }
            if (!['import', 'export', 'sync', 'connect', 'authorize', 'disconnect', 'merge-preview', 'merge-cloud-preview', 'merge-confirm', ...(controls ? ['panel-action'] : [])].includes(action)) {
                send(404, { error: '操作不存在。' });
                return;
            }
            const limit = action === 'import' || action === 'merge-preview' ? 512 * 1024 * 1024 : 16 * 1024;
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                const bytes = Buffer.from(chunk);
                size += bytes.length;
                if (size > limit) {
                    send(413, { error: '文件或请求超过大小限制。' });
                    return;
                }
                chunks.push(bytes);
            }
            const bytes = Buffer.concat(chunks);
            if (action === 'panel-action' && controls) {
                await transfer.ready;
                send(200, await controls.action(JSON.parse(bytes.toString('utf8'))));
                return;
            }
            if (['import', 'export', 'merge-cloud-preview', 'merge-confirm'].includes(action))
                await transfer.ready;
            if (action === 'merge-preview') {
                send(200, transfer.prepareOwnerMerge(bytes));
                return;
            }
            if (action === 'merge-cloud-preview') {
                send(200, await transfer.prepareCloudOwnerMerge());
                return;
            }
            if (action === 'merge-confirm') {
                const value = JSON.parse(bytes.toString('utf8'));
                if (typeof value['previewToken'] !== 'string' || typeof value['confirmation'] !== 'string') {
                    send(400, { error: '请先预览并明确确认同一用户。' });
                    return;
                }
                send(200, transfer.confirmOwnerMerge(value['previewToken'], value['confirmation']));
                return;
            }
            if (action === 'import') {
                const result = transfer.importBytes(bytes);
                send(200, result);
                if (transfer.status().enabled)
                    void transfer.sync();
                return;
            }
            if (action === 'export') {
                const result = transfer.exportLocal(), id = randomUUID();
                downloads.set(id, result.file);
                if (downloads.size > 32)
                    downloads.delete(downloads.keys().next().value);
                send(200, { name: basename(result.file), upload: result.upload, download: `/companion-memory/api/download?id=${id}&token=${token}` });
                return;
            }
            if (action === 'sync') {
                send(200, await transfer.sync());
                return;
            }
            if (action === 'connect') {
                const value = JSON.parse(bytes.toString('utf8'));
                if (['appKey', 'secretKey', 'appFolder'].some(key => typeof value[key] !== 'string')) {
                    send(400, { error: '请填写完整的应用信息。' });
                    return;
                }
                send(200, await transfer.beginAuthorization(value));
                return;
            }
            if (action === 'authorize') {
                send(200, await transfer.finishAuthorization());
                return;
            }
            await transfer.disconnect();
            send(200, { ok: true });
        }
        catch (error) {
            const pending = error?.code === 'authorization_pending';
            const ownerMismatch = error instanceof PortableImportError && error.code === 'owner-mismatch';
            send(ownerMismatch ? 409 : 400, { ...(ownerMismatch ? { code: 'owner-mismatch' } : {}), error: error instanceof ConfigError || error instanceof PanelInputError || error instanceof OwnerMergeInputError ? error.message : pending ? '百度授权尚未完成，请完成后再试。' : ownerMismatch ? '文件与本机的主人编号不同，已停止普通导入并保留本地记忆。若两边都是你，请使用“两台已有记忆首次配对”预览合并。' : action.startsWith('merge-') ? '合并未执行。请重新预览；确认两份文件属于同一用户，且本机记忆未变化、没有阻断冲突。双方原始记忆仍保留。' : action === 'panel-action' ? '操作未完成，请检查输入或查看运行状态。本地数据已保留。' : '操作未完成，请检查文件格式、同步状态或百度授权。本地记忆已保留。' });
        }
    };
}
//# sourceMappingURL=transfer-ui.js.map