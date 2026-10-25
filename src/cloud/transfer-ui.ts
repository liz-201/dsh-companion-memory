import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MemoryTransfer } from './memory-transfer.js'
import { PortableImportError } from '../storage/portable.js'

const html = (token: string): string => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆管理</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 24px;color:#233044;background:#f6f8fb}section{background:white;border:1px solid #dde3ed;border-radius:14px;padding:22px;margin:20px 0}h1{font-size:28px}h2{font-size:19px;margin-top:0}button,a.button{font:inherit;background:#245fca;color:white;border:0;border-radius:7px;padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block;margin:5px 8px 5px 0}button.secondary{background:#e7edf6;color:#233044}input{font:inherit;display:block;width:95%;padding:9px;margin:7px 0 14px;border:1px solid #bbc7d9;border-radius:6px}small{color:#58677d}#message{white-space:pre-wrap}button:disabled{opacity:.5;cursor:wait}.status{white-space:pre-wrap;font-size:14px}label{display:block}</style>
<h1>记忆管理</h1><p>导出一个完整记忆文件，或从文件恢复。连接百度网盘后，打开 DSH 会自动检查云端并合并记忆。</p>
<section><h2>记忆文件</h2><button id="export">导出并下载记忆</button><label>导入记忆文件<input id="file" type="file" accept=".json,.companion.json"></label><button id="import">导入所选记忆</button><p><small>导入前自动备份，保留双方新增内容与冲突记录。不会覆盖当前插件程序，也不会重发旧的待发消息。</small></p><span id="download"></span></section>
<section><h2>百度网盘</h2><p id="cloud-state">正在读取状态…</p><button id="sync">立即同步</button><button id="disconnect" class="secondary">断开网盘</button><details><summary>首次连接或更换应用</summary><p><small>填写你在百度网盘开放平台创建的应用信息。授权只在百度官方页面完成。</small></p><label>AppKey<input id="appKey" autocomplete="off"></label><label>SecretKey<input id="secretKey" type="password" autocomplete="off"></label><label>应用目录名<input id="appFolder" placeholder="网盘 /apps/ 下该应用的目录名" autocomplete="off"></label><button id="connect">连接百度网盘</button><div id="authorize"></div><button id="finish" hidden>我已完成百度授权</button></details><p><small>连接成功后自动同步；导出记忆也会安排上传。每台电脑分别保存快照，离线期间的修改会在下次同步时合并。</small></p></section>
<section><h2>运行状态</h2><div id="status" class="status"></div><p id="message" role="status" aria-live="polite"></p></section>
<script>const token=${JSON.stringify(token)}, base='/companion-memory/api/', $=id=>document.getElementById(id);let working=false;
async function request(action,body,raw=false){const r=await fetch(base+action,{method:body===undefined?'GET':'POST',headers:{'x-companion-token':token,...(body===undefined?{}:{'content-type':raw?'application/octet-stream':'application/json'})},body:body===undefined?undefined:raw?body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'操作未完成');return v}
function describe(s){$('cloud-state').textContent=s.connected?(s.enabled?'百度网盘已连接，自动同步已开启':'百度网盘已连接，自动同步已暂停'):'尚未连接百度网盘';$('status').textContent='同步状态：'+(s.busy?'进行中':s.error?'需要处理':'空闲')+'\\n上次成功同步：'+(s.lastSyncAtMs?new Date(s.lastSyncAtMs).toLocaleString():'尚无')+'\\n本次运行导入文件：'+s.imported+'；冲突：'+s.conflicts+(s.lineageMissing?'\\n部分文件缺少共同历史，已保留冲突供核对。':'')+(s.error?'\\n'+s.error:'')}
async function refresh(){try{describe(await request('status'))}catch(e){$('message').textContent=e.message}}
async function run(fn){if(working)return;working=true;try{$('message').textContent='正在处理…';await fn()}catch(e){$('message').textContent=e.message}finally{working=false;await refresh()}}
$('export').onclick=()=>run(async()=>{const v=await request('export',{});const a=document.createElement('a');a.href=v.download;a.textContent='下载记忆文件';a.className='button';a.download=v.name;$('download').replaceChildren(a);a.click();$('message').textContent=v.upload==='queued'?'记忆已导出，已安排上传；可在运行状态查看同步结果。':'记忆已导出。连接百度网盘后可自动上传。'});
$('import').onclick=()=>run(async()=>{const f=$('file').files[0];if(!f)throw Error('请先选择记忆文件');if(f.size>536870912)throw Error('记忆文件超过大小限制');const r=await request('import',await f.arrayBuffer(),true);$('message').textContent='导入完成：新增 '+r.inserted+'，更新 '+r.updated+'，冲突 '+r.conflicts+(r.alreadyImported?'（该文件已处理）':'')+(r.lineageMissing?'。部分历史缺少共同祖先，已保留差异。':'');});
$('connect').onclick=()=>run(async()=>{const v=await request('connect',{appKey:$('appKey').value,secretKey:$('secretKey').value,appFolder:$('appFolder').value});$('secretKey').value='';const a=document.createElement('a');a.href=v.verificationUrl;a.target='_blank';a.rel='noopener noreferrer';a.textContent='打开百度官方授权页';a.className='button';const p=document.createElement('p');p.textContent='授权码：'+v.userCode;$('authorize').replaceChildren(a,p);$('finish').hidden=false;$('message').textContent='请在百度官方页面登录并授权，然后点击“我已完成百度授权”。';});
$('finish').onclick=()=>run(async()=>{const s=await request('authorize',{});describe(s);$('finish').hidden=true;$('authorize').replaceChildren();$('message').textContent=s.error||'授权成功，已执行首次同步。'});
$('sync').onclick=()=>run(async()=>{const s=await request('sync',{});describe(s);$('message').textContent=s.error||(s.enabled?'同步完成。':'请先连接百度网盘。')});
$('disconnect').onclick=()=>run(async()=>{await request('disconnect',{});$('message').textContent='已断开。本地记忆和云端已有文件均保留。'});refresh();setInterval(refresh,5000);</script></html>`

/** Loopback UI with an unguessable same-origin action token; no CORS/credential echo. */
export function createTransferHandler(transfer: MemoryTransfer) {
  const token = randomUUID() + randomUUID()
  const downloads = new Map<string, string>()
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'" }
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (code: number, value: unknown): void => { response.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)) }
    const remote = request.socket?.remoteAddress
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) { send(403, { error: '仅限本机访问。' }); return }
    let url: URL
    try { url = new URL(request.url ?? '/', `http://${request.headers.host}`) } catch { send(400, { error: '地址无效。' }); return }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { send(403, { error: '仅限本机地址。' }); return }
    if (url.pathname === '/companion-memory/manage' && request.method === 'GET') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); response.end(html(token)); return
    }
    if (!url.pathname.startsWith('/companion-memory/api/')) { send(404, { error: '页面不存在。' }); return }
    const provided = request.headers['x-companion-token'] ?? url.searchParams.get('token')
    if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) { send(403, { error: '请重新打开记忆管理页。' }); return }
    const origin = request.headers.origin
    if (origin && origin !== url.origin) { send(403, { error: '请求来源无效。' }); return }
    const action = url.pathname.slice('/companion-memory/api/'.length)
    try {
      if (request.method === 'GET' && action === 'status') { send(200, transfer.status()); return }
      if (request.method === 'GET' && action === 'download') {
        const file = downloads.get(url.searchParams.get('id') ?? '')
        if (!file) { send(404, { error: '请重新导出记忆文件。' }); return }
        response.writeHead(200, { ...headers, 'content-type': 'application/json', 'content-disposition': `attachment; filename="${basename(file)}"` }); response.end(readFileSync(file)); return
      }
      if (request.method !== 'POST') { send(405, { error: '不支持的操作。' }); return }
      if (!['import', 'export', 'sync', 'connect', 'authorize', 'disconnect'].includes(action)) { send(404, { error: '操作不存在。' }); return }
      const limit = action === 'import' ? 512 * 1024 * 1024 : 16 * 1024
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > limit) { send(413, { error: '文件或请求超过大小限制。' }); return } chunks.push(bytes) }
      const bytes = Buffer.concat(chunks)
      if (action === 'import' || action === 'export') await transfer.ready
      if (action === 'import') { const result = transfer.importBytes(bytes); send(200, result); if (transfer.status().enabled) void transfer.sync(); return }
      if (action === 'export') {
        const result = transfer.exportLocal(), id = randomUUID()
        downloads.set(id, result.file)
        if (downloads.size > 32) downloads.delete(downloads.keys().next().value!)
        send(200, { name: basename(result.file), upload: result.upload, download: `/companion-memory/api/download?id=${id}&token=${token}` }); return
      }
      if (action === 'sync') { send(200, await transfer.sync()); return }
      if (action === 'connect') {
        const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
        if (['appKey', 'secretKey', 'appFolder'].some(key => typeof value[key] !== 'string')) { send(400, { error: '请填写完整的应用信息。' }); return }
        send(200, await transfer.beginAuthorization(value as { appKey: string; secretKey: string; appFolder: string })); return
      }
      if (action === 'authorize') { send(200, await transfer.finishAuthorization()); return }
      await transfer.disconnect(); send(200, { ok: true })
    } catch (error) {
      const pending = (error as { code?: string })?.code === 'authorization_pending'
      const ownerMismatch = error instanceof PortableImportError && error.code === 'owner-mismatch'
      send(400, { error: pending ? '百度授权尚未完成，请完成后再试。' : ownerMismatch ? '文件与本机记忆属于不同主人，已停止合并，本地记忆已保留。请在开始聊天前，用同一主人的记忆初始化新设备。' : '操作未完成，请检查文件格式、同步状态或百度授权。本地记忆已保留。' })
    }
  }
}
