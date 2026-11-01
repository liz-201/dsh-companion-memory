export const intimacySections = `
<section id="intimacy-panel"><h2>成人亲密吸引</h2><p>默认关闭，仅用于成年人之间非露骨的亲密表达。这是角色的计算状态，不是对用户身体或心理的判断；不会提高主动联系频率。</p>
<pre id="intimacy-state"></pre><label><input id="intimacy-enabled" type="checkbox">在本机启用</label>
<label><input id="intimacy-owner-adult" type="checkbox">我确认自己已成年</label><label><input id="intimacy-character-adult" type="checkbox">我确认当前角色已成年</label>
<p class="muted">更换角色后需重新确认角色范围。许可与成年声明不上传；停止记录会在联网同步后传给其他设备。停止后需要明确恢复，旧记忆不会自动重启该能力。</p>
<button id="save-intimacy">保存本机范围</button><button id="stop-intimacy" class="danger">立即停止这类表达</button></section>`

export const intimacyScript = `
let latestIntimacyPolicy=null,intimacyDirty=false;
function intimacyRender(s){
 if(!$('intimacy-panel')||!s.eroticPolicy)return;
 latestIntimacyPolicy=s.eroticPolicy;const c=s.eroticState,p=s.eroticPolicy;
 const labels={'owner-stop':'已按你的停止指令暂停；明确恢复前不会表达','adult-context-unknown':'成年人范围尚未确认，模块不可用','disabled':'模块未开启'};
 $('intimacy-state').textContent=!c?'当前未提供此状态':c.blockReason?labels[c.blockReason]||'当前不可用':c.value===null?'暂无合格证据，状态未知':(c.value===0?'当前强度为0':'当前计算强度 '+c.value.toFixed(3))+'；依据 '+c.evidenceIds.length+' 条';
 if(!intimacyDirty){$('intimacy-enabled').checked=p.enabled;$('intimacy-owner-adult').checked=p.ownerAdultConfirmed;$('intimacy-character-adult').checked=p.characterAdultConfirmed;}
}
if($('intimacy-panel')){
 for(const id of ['intimacy-enabled','intimacy-owner-adult','intimacy-character-adult'])$(id).addEventListener('input',()=>{intimacyDirty=true});
 $('save-intimacy').onclick=()=>run(async()=>{
  const p=latestIntimacyPolicy||{},enabled=$('intimacy-enabled').checked;
  if(enabled&&!window.confirm(p.stopped?'确认重新允许当前成年角色的非露骨亲密表达？这不会恢复停止前的旧证据。':'确认在本机开启成年人、非露骨的亲密表达范围？'))return;
  await panelAction('intimacy-settings',{policy:{enabled,ownerAdultConfirmed:$('intimacy-owner-adult').checked,characterAdultConfirmed:$('intimacy-character-adult').checked},confirmed:true,confirmedResume:enabled&&p.stopped,knownStopIds:p.stopIds||[]});
  intimacyDirty=false;await refreshPanel();
 });
 $('stop-intimacy').onclick=()=>run(async()=>{await panelAction('intimacy-stop');intimacyDirty=false;await refreshPanel()});
}
`
