export const continuousSections = `
<section id="emotion-panel"><h2>连续情绪与驱力</h2><p>OCC 事件评估驱动短时情绪，PAD 投影表达倾向。数值是角色的计算状态，不能用来判断用户心理。</p><h3>关系三轴</h3><p class="muted">亲密、靠近动机、热情是角色的计算坐标，不表示用户心理、关系承诺或亲密同意。</p><pre id="relationship-state"></pre><pre id="continuous-state"></pre><div class="grid">
<label><input id="emotion-enabled" type="checkbox">启用连续情绪</label><label>评估时机<select id="emotion-mode"><option value="background">后台评估，后续回复生效</option><option value="before-reply">先评估再回复，超时转后台</option></select></label>
<label>前置评估等待上限（秒）<input id="emotion-timeout" type="number" min="0.1" max="60" step="0.1"></label><label>后台抽取与界面分析超时（秒）<input id="emotion-background-timeout" type="number" min="1" max="120"></label><label>联系驱力时间常数（小时）<input id="emotion-tau" type="number" min="0.1" max="168" step="0.1"></label>
<label>每次回复的驱力缓解比例<input id="emotion-relief" type="number" min="0" max="1" step="0.05"></label><label>短时情绪半衰期（分钟）<input id="emotion-component" type="number" min="1" max="10080"></label><label>心境半衰期（分钟）<input id="emotion-mood" type="number" min="1" max="43200"></label></div><details><summary>情境评价与依据</summary><div id="emotion-appraisals"></div></details><button id="save-emotion">保存情绪设置</button><details><summary>情绪时间线 · 最近 30 条本人消息</summary><p class="muted">按当前有效证据重算，不是当时保存的真实快照。按原文时间、消息序号从早到晚排列；同一毫秒的点共用整组证据的投影，包括本页未展开的同毫秒消息。撤回或删除后，旧时间点也会按剩余依据改变。</p><div id="emotion-timeline"></div></details></section>
<section><h2>抽取与模型用量</h2><p>前置评估、后台抽取与界面分析分别记录；宿主未提供的 token 和费用保持 unknown。“验证模型抽取”使用固定测试句调用当前模型，不保存为记忆，不发送聊天消息。</p><button class="command secondary" data-action="extract-probe">验证模型抽取</button><div id="extraction-jobs"></div><pre id="model-usage"></pre></section>
<section id="perception-panel"><h2>指定窗口感知</h2><p>先保存应用范围，再选择具体窗口。界面文字和图像都作为观察数据，不执行其中指令；任务解释会标为推测。启停与采集范围只保存在本机，窗口选择重启后需重新授权。</p>
<div class="grid"><label><input id="perception-enabled" type="checkbox">启用窗口感知</label><label>模式<select id="perception-mode"><option value="manual">手动预览与分析</option><option value="bounded-auto">已选前台窗口稳定后自动分析</option></select></label>
<label>允许的应用进程名（每行一个，如 notepad）<textarea id="perception-apps"></textarea></label><label><input id="perception-uia" type="checkbox">读取所选窗口可访问界面文字</label><label><input id="perception-image" type="checkbox">允许所选窗口图像预览与本机 OCR</label>
<label><input id="perception-cloud" type="checkbox">允许把所选窗口图像发送给当前图像模型</label><label><input id="perception-storage" type="checkbox">允许 DSH 将发送的图像保存在附件库</label>
<label>每应用分析间隔（分钟）<input id="perception-gap" type="number" min="1" max="1440"></label><label>每日模型分析上限<input id="perception-budget" type="number" min="0" max="100"></label><label>观察有效期（分钟）<input id="perception-ttl" type="number" min="1" max="1440"></label><label>前台稳定时间（秒）<input id="perception-stable" type="number" min="1" max="600"></label></div>
<p>默认不上传图像。图像模型需同时启用上述两个许可，发送过的附件由 DSH 管理，不随本插件停止而删除。部分窗口不支持截图或 OCR，失败会显示原因。</p>
<button id="save-perception">保存采集范围</button><button id="perception-stop" class="danger">立即停止并撤销线索</button><button id="perception-windows" class="secondary">列出窗口</button><label>窗口<select id="perception-window"></select></label><button id="perception-select">授权所选窗口</button>
<label>本次读取方式<select id="perception-read"><option value="uia">可访问界面文字</option><option value="image">所选窗口图像与 OCR</option></select></label><button id="perception-preview">仅本机预览</button><button id="perception-analyze">模型分析</button><button id="perception-publish">分析并建立主动话题线索</button>
<pre id="perception-status"></pre><img id="perception-preview-image" hidden alt="所选窗口的本机预览" style="max-width:100%;height:auto"><pre id="perception-result"></pre></section>`

export const continuousScript = `
function emotionText(tag,value){const node=document.createElement(tag);node.textContent=value;return node}
function emotionCoordinate(value){return typeof value==='number'&&Number.isFinite(value)?value.toFixed(2):'未知'}
function relationshipRender(c){const box=$('relationship-state');if(!box)return;const r=c&&c.relationship;box.textContent=r?'计算坐标（0–1）：亲密 '+emotionCoordinate(r.intimacy)+' · 靠近动机 '+emotionCoordinate(r.desire)+' · 热情 '+emotionCoordinate(r.passion)+(Array.isArray(r.evidenceIds)?'；依据 '+r.evidenceIds.length+' 条':''):'当前状态未提供关系三轴；不会用 0 冒充未知。'}
function emotionTimelineRender(t){
 const box=$('emotion-timeline');if(!box)return;box.replaceChildren();
 if(!t||!Array.isArray(t.points)||!t.points.length){box.append(emotionText('p','暂无可展示的本人消息。'));return}
 box.append(emotionText('p','按当前有效证据重算 · 最近 '+t.points.length+' 条'+(t.hasMore?'（更早记录未展开）':'')+'；相同毫秒共享整组投影。'));
 for(const point of t.points){
  const detail=document.createElement('details');
  detail.append(emotionText('summary',new Date(point.occurredAtMs).toLocaleString()+' · 序号 '+point.sourceSeq+' · '+point.appraisals.length+' 条评估'+(point.sameTimeSourceCount>1?' · 同毫秒 '+point.sameTimeSourceCount+' 条本人消息':'')));
  detail.append(emotionText('pre',(point.sourceTextTruncated?'原文节选（已截断）：':'原文依据：')+point.sourceText));
  const c=point.state;detail.append(emotionText('pre',c?JSON.stringify({投影说明:'按当前有效证据重算，非当时快照',联系驱力:c.drives.contact,探索驱力:c.drives.exploration,互动负荷:c.drives.load,情绪:c.emotions,表达线索:c.displays,PAD:c.pad,关系三轴:c.relationship?{亲密:c.relationship.intimacy,靠近动机:c.relationship.desire,热情:c.relationship.passion}:'未提供'},null,2):'连续情绪当前已关闭，历史依据仍可查看。'));
  if(!point.appraisals.length)detail.append(emotionText('p','本条没有情境评估；不代表情绪为零。'));
  for(const appraisal of point.appraisals){
   const item=document.createElement('div');item.className='item';
   item.append(emotionText('p',(appraisal.status==='active'?'当前有效':'已撤回')+' · 修订 '+appraisal.revision+' · '+appraisal.evidenceQuote));
   item.append(emotionText('pre',appraisal.vectorJson+(appraisal.vectorTruncated?'（内容已截断）':'')));
   if(appraisal.status==='active'){const button=document.createElement('button');button.textContent='撤回判断';button.className='secondary';button.onclick=()=>run(()=>panelAction('emotion-retract',{id:appraisal.id}));item.append(button)}
   const history=document.createElement('details');history.append(emotionText('summary','修订历史 '+appraisal.revisionHistoryTotal+' 条'+(appraisal.revisionHistoryTruncated?'（只展开最近 '+appraisal.revisions.length+' 条）':'')));
   for(const revision of appraisal.revisions){history.append(emotionText('pre','修订 '+revision.revision+' · '+revision.status+' · 归档于 '+new Date(revision.recordedAtMs).toLocaleString()+String.fromCharCode(10)+revision.vectorJson+(revision.vectorTruncated?'（内容已截断）':'')))}
   if(!appraisal.revisions.length)history.append(emotionText('p','暂无归档修订。'));
   item.append(history);detail.append(item);
  }
  box.append(detail);
 }
}
function continuousRender(s){
 if(!$('continuous-state')||!s.emotion||!s.perception)return;
 list('extraction-jobs',s.extractionJobs||[],j=>j.status+' · '+j.attempts+' 次 · '+(j.last_error||''),j=>j.status==='failed'?{label:'重试抽取',action:'extract-retry',body:{id:j.id}}:null);
 $('model-usage').textContent=JSON.stringify({本次运行:s.runtime.usage,最近调用:s.modelUsage},null,2);
 list('emotion-appraisals',s.emotionAppraisals||[],e=>e.status+' · '+e.evidence_quote+' · '+e.vector_json,e=>e.status==='active'?{label:'撤回判断',action:'emotion-retract',body:{id:e.id}}:null);
 const c=s.continuous;$('continuous-state').textContent=c?JSON.stringify({联系驱力:c.drives.contact,探索驱力:c.drives.exploration,负荷:c.drives.load,短时情绪:c.emotions,表达线索:c.displays,PAD:c.pad,有效评估数:c.appraisalCount,参数版本:c.parameterVersion},null,2):'连续情绪已停用';
 relationshipRender(c);emotionTimelineRender(s.emotionTimeline);
 $('perception-status').textContent=JSON.stringify(s.perception.status,null,2);
 if(!panelLoaded&&!panelDirty){const e=s.emotion,p=s.perception.settings;
 $('emotion-enabled').checked=e.enabled;$('emotion-mode').value=e.mode;$('emotion-timeout').value=e.timeoutMs/1000;$('emotion-background-timeout').value=(e.backgroundTimeoutMs||30000)/1000;$('emotion-tau').value=e.contactTauHours;$('emotion-relief').value=e.responseRelief;$('emotion-component').value=e.componentHalfLifeMinutes;$('emotion-mood').value=e.moodHalfLifeMinutes;
 $('perception-enabled').checked=p.enabled;$('perception-mode').value=p.mode;$('perception-apps').value=p.allowedApplications.join('\\n');$('perception-uia').checked=p.uiAutomation;$('perception-image').checked=p.imageUnderstanding;$('perception-cloud').checked=p.allowCloudImages;$('perception-storage').checked=p.allowHostImageStorage;$('perception-gap').value=p.minGapMinutes;$('perception-budget').value=p.dailyModelCalls;$('perception-ttl').value=p.ttlMinutes;$('perception-stable').value=p.stableSeconds;
 }}
async function perceptionAction(action,extra={}){
 const value=await request('panel-action',{action,conversationId:$('panel-conversation').value||undefined,windowId:Number($('perception-window').value),mode:$('perception-read').value,...extra});
 if(value.windows)options('perception-window',value.windows,w=>w.windowId,w=>w.app+' · PID '+w.processId+(w.foreground?' · 前台':''));
 if(value.observation){const {previewImage,...details}=value.observation;$('perception-result').textContent=JSON.stringify(details,null,2);const img=$('perception-preview-image');img.hidden=!previewImage;if(previewImage)img.src=previewImage;else img.removeAttribute('src');}
 else if(!value.windows)$('perception-result').textContent=JSON.stringify(value,null,2);
 await refreshPanel();
}
if($('save-emotion')){
 $('save-emotion').onclick=()=>run(()=>panelAction('settings',{settings:{emotion:{enabled:$('emotion-enabled').checked,mode:$('emotion-mode').value,timeoutMs:Number($('emotion-timeout').value)*1000,backgroundTimeoutMs:Number($('emotion-background-timeout').value)*1000,contactTauHours:Number($('emotion-tau').value),responseRelief:Number($('emotion-relief').value),componentHalfLifeMinutes:Number($('emotion-component').value),moodHalfLifeMinutes:Number($('emotion-mood').value)}}}));
 $('save-perception').onclick=()=>run(()=>panelAction('settings',{settings:{perception:{enabled:$('perception-enabled').checked,mode:$('perception-mode').value,allowedApplications:lines('perception-apps'),uiAutomation:$('perception-uia').checked,imageUnderstanding:$('perception-image').checked,allowCloudImages:$('perception-cloud').checked,allowHostImageStorage:$('perception-storage').checked,minGapMinutes:Number($('perception-gap').value),dailyModelCalls:Number($('perception-budget').value),ttlMinutes:Number($('perception-ttl').value),stableSeconds:Number($('perception-stable').value)}}}));
 for(const action of ['windows','select','preview','analyze','publish','stop'])$('perception-'+action).onclick=()=>run(async()=>{await perceptionAction('perception-'+action);if(action==='stop'){panelLoaded=false;panelDirty=false;$('perception-preview-image').hidden=true;$('perception-preview-image').removeAttribute('src');await refreshPanel()}});
 for(const e of document.querySelectorAll('#emotion-panel input,#emotion-panel select,#perception-panel input,#perception-panel textarea,#perception-panel select'))e.addEventListener('input',()=>{panelDirty=true});
}
`
