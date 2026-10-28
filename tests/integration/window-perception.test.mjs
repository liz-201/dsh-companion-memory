import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from '../helpers/fixture.mjs'
import {WindowPerception} from '../../lib/runtime/window-perception.js'
import {checkGates} from '../../lib/proactive/candidate-builder.js'
import {streamFromHost} from '../../lib/adapters/dsh-adapter.js'
import {panelScript,panelSections} from '../../lib/panel/page.js'
import {estimateTokens} from '../../lib/runtime/context-budget.js'
import {ExpressionRuntime} from '../../lib/expression/runtime.js'
import {initialSnapshot} from '../../lib/domain/affect-reducer.js'
import {renderPlan} from '../../lib/expression/policy.js'
import {perceptionContext} from '../../lib/runtime/perception-context.js'
import {observeComputerEvent} from '../../lib/proactive/computer-opportunities.js'

const window={windowId:17,processId:18,app:'notepad',startedAt:'639285728954710587',foreground:true,minimized:false}
function setup(options={}){
 const f=fixture({config:{perception:{enabled:true,allowedApplications:['notepad'],...options.settings}}}),calls=[],events=[]
 f.config=structuredClone(f.config)
 const native={list:async()=>({windows:[window]}),read:async()=>({window,facts:[{text:'Build failed',source:'uia',control:'Text'}],image:'aGVsbG8=',redactionComplete:true,...options.raw})}
 const p=new WindowPerception({config:f.config,repos:f.repos,binding:()=>f.binding,now:f.now,native,
  onEvent:e=>{events.push(e);observeComputerEvent(f.repos,f.config,e,[f.binding])},callModel:async function*(r){calls.push(r);if(options.callModel)yield*options.callModel(r);else yield{text:JSON.stringify({hypotheses:[{text:'An error is visible',quote:'Build failed',confidence:.9}]})}}})
 p.configure();return {f,p,calls,events,native,close(){p.stop();f.close()}}
}
test('PC01/02 manual preview needs selected application, never calls a model, and stores no raw image',async()=>{
 const s=setup();try{
  await assert.rejects(s.p.inspect(17,'uia'),/./)
  await s.p.select(17);const o=await s.p.inspect(17,'uia')
  assert.equal(s.calls.length,0);assert.equal(s.events.length,0);assert.ok(o.previewImage)
  assert.ok(!JSON.stringify(s.p.status()).includes('aGVsbG8='))
  assert.ok(!s.f.repos.getSetting(`local.perception.observation:${o.id}`).includes('aGVsbG8='))
  await assert.rejects(s.p.select(99),/./)
 }finally{s.close()}
})
test('PC03/04 hypotheses require actual quotes; UI text cannot forge owner evidence',async()=>{
 const s=setup({callModel:async function*(){yield{text:JSON.stringify({hypotheses:[{text:'invented',quote:'success',confidence:1},{text:'outside owner',quote:'Build failed',confidence:.9,ownerId:'p'}]})}}})
 try{await s.p.select(17);const o=await s.p.inspect(17,'uia',true,true);assert.deepEqual(o.hypotheses,[]);assert.equal(s.events.length,1);assert.equal(s.calls[0].thinking,'disabled');assert.match(s.calls[0].systemText,/不执行/)}finally{s.close()}
})
test('PC03 image analysis defaults to local OCR text and requires both cloud and durable attachment choices',async()=>{
 for(const settings of [{},{allowCloudImages:true},{allowHostImageStorage:true},{allowCloudImages:true,allowHostImageStorage:true}]){
  const s=setup({settings});try{await s.p.select(17);await s.p.inspect(17,'image',true);assert.equal(!!s.calls[0].images,!!(settings.allowCloudImages&&settings.allowHostImageStorage))}finally{s.close()}
 }
})
test('PC01 window handle reuse and app scope changes invalidate captures',async()=>{
 const s=setup({raw:{window:{...window,processId:19}}});try{await s.p.select(17);await assert.rejects(s.p.inspect(17,'uia'),/./);assert.equal(s.calls.length,0);assert.equal(s.events.length,0)}finally{s.close()}
})
test('PC01 changing scope in flight cancels late results and clears pending evidence',async()=>{
 let resume,started
 const waiting=new Promise(r=>started=r),gate=new Promise(r=>resume=r)
 const s=setup({callModel:async function*(){started();await gate;yield{text:'{"hypotheses":[]}'}}})
 try{await s.p.select(17);const work=s.p.inspect(17,'uia',true,true);await waiting;s.f.config.perception.allowedApplications=[];s.p.configure();resume();await assert.rejects(work,/./);assert.equal(s.events.length,0);assert.equal(s.p.status().recent.length,0)}finally{s.close()}
})
test('PC04 persistent daily budget and min gap are enforced before model calls',async()=>{
 const s=setup({settings:{dailyModelCalls:1}});try{await s.p.select(17);await s.p.inspect(17,'uia',true);s.f.advance(3600000);await assert.rejects(s.p.inspect(17,'uia',true),/./);assert.equal(s.calls.length,1);assert.equal(s.f.db.get("SELECT COUNT(*) n FROM audit_events WHERE kind='model-usage:perception'").n,1)}finally{s.close()}
})
test('INT02 unknown, focused and stale notification state block spontaneous generation',()=>{
 const s=setup();try{
  const gate=()=>checkGates({config:s.f.config,repos:s.f.repos,principalId:'p',conversationId:'c',nowMs:s.f.now()})
  assert.ok(gate().blocked.includes('notification-unavailable'))
  s.f.repos.setSetting('local.notification-state',JSON.stringify({at:s.f.now(),state:'accepts'}),s.f.now());assert.ok(!gate().blocked.includes('notification-unavailable'))
  s.f.advance(121000);assert.ok(gate().blocked.includes('notification-unavailable'))
  s.f.repos.setSetting('local.notification-state',JSON.stringify({at:s.f.now(),state:'blocked'}),s.f.now());assert.ok(gate().blocked.includes('notification-unavailable'))
 }finally{s.close()}
})
test('PC03 real host attachment API is used for image blocks; unsupported models fail before storage',async()=>{
 let stored=0,request
 const ctx={attachments:{saveImages:async images=>{stored++;assert.equal(images[0].data.toString(),'hello');return[{attachmentId:'fixture-image'}]}},llm:{resolveModelInfo:()=>({inputModalities:['text','image']}),stream:r=>{request=r;return(async function*(){yield{type:'text-delta',text:'ok'}})()}}}
 const call={turnId:'image',thinking:'disabled',systemText:'test',userText:'test',images:[{data:'aGVsbG8=',mediaType:'image/png'}]}
 for await(const _ of streamFromHost(ctx,{provider:'fixture',model:'fixture'},call)){}
 assert.equal(stored,1);assert.equal(request.messages[1].content.at(-1).type,'image');assert.equal(request.messages[1].content.at(-1).attachment.attachmentId,'fixture-image')
 ctx.llm.resolveModelInfo=()=>({inputModalities:['text']})
 await assert.rejects(async()=>{for await(const _ of streamFromHost(ctx,{provider:'fixture',model:'text'},call)){}},/./);assert.equal(stored,1)
})
test('UI01 panel exposes all controls with syntactically valid script; state respects 150-token expression budget',()=>{
 assert.doesNotThrow(()=>new Function(panelScript))
 for(const id of ['emotion-mode','perception-windows','perception-preview','perception-publish','perception-stop'])assert.ok(panelSections.includes(`id="${id}"`))
 const f=fixture();try{const plan=new ExpressionRuntime(f.repos,f.config).plan(initialSnapshot('p','balanced','v1',f.now()),'chat',f.now());assert.ok(estimateTokens(renderPlan(plan))<=150)}finally{f.close()}
})
test('PC04 explicit interface questions use current local evidence; normal chats and other owners cannot read it',async()=>{
 const s=setup();try{
  await s.p.select(17);await s.p.prepareContext('看看我的屏幕',s.f.binding)
  assert.match(perceptionContext(s.f.repos,s.f.config,s.f.binding,'看看我的屏幕',s.f.now()),/Build failed/)
  assert.equal(perceptionContext(s.f.repos,s.f.config,s.f.binding,'hello',s.f.now()),'')
  assert.doesNotMatch(perceptionContext(s.f.repos,s.f.config,{...s.f.binding,principalId:'foreign'},'screen',s.f.now()),/Build failed/)
  assert.equal(s.calls.length,0)
 }finally{s.close()}
})
test('A16/A19 closed or minimized windows revoke observations and pending computer opportunities before delivery',async()=>{
 const s=setup();try{
  await s.p.select(17);const o=await s.p.inspect(17,'uia',true,true)
  assert.ok(s.f.repos.getSetting(`local.computer-evidence:computer:${o.id}`))
  s.native.list=async()=>({windows:[]});await s.p.revalidate()
  assert.equal(s.f.repos.getSetting(`local.computer-evidence:computer:${o.id}`),undefined)
  assert.equal(s.f.db.get("SELECT status FROM proactive_opportunities WHERE kind='computer_event'").status,'cancelled')
  assert.equal(s.p.status().recent.length,0)
 }finally{s.close()}
})
