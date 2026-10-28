import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { continuousAffect,saveEmotionAppraisals } from '../../lib/storage/continuous-affect.js'
import { ExpressionRuntime } from '../../lib/expression/runtime.js'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { renderPlan } from '../../lib/expression/policy.js'
import { parseObservation } from '../../lib/runtime/emotion-observation.js'
import { streamFromHost } from '../../lib/adapters/dsh-adapter.js'

function message(f,id,at=f.now(),role='user'){
 return f.repos.insertRawMessage({id,conversationId:'c',platformMessageKey:id,role,sourceKind:'dsh',content:'你记得我喜欢蓝色，谢谢你',occurredAtMs:at,observedAtMs:at,deliveryStatus:null,deletedAtMs:null}).row
}
const vector={focus:'action',agency:'owner',desirability:.9,praiseworthiness:.9,personalAttention:.9,relevance:.9,quote:'谢谢你',confidence:.95}
test('message response ledger settles once independently of 0/1/multiple or delayed appraisals',()=>{
 const f=fixture();try{
  const first=message(f,'first'),second=message(f,'second');message(f,'first');message(f,'assistant',f.now(),'assistant')
  assert.equal(f.db.get('SELECT COUNT(*) n FROM response_events').n,2)
  const before=continuousAffect(f.repos,f.config,'p',f.now()+3600000).drives
  saveEmotionAppraisals(f.repos,f.binding,first,[vector, {...vector,focus:'object',appealingness:.7}])
  saveEmotionAppraisals(f.repos,f.binding,second,[vector])
  assert.deepEqual(continuousAffect(f.repos,f.config,'p',f.now()+3600000).drives,{...before,exploration:.1*Math.pow(2,-60/90)})
  const changes=f.db.get('SELECT total_changes() n').n
  const a=continuousAffect(f.repos,f.config,'p',f.now()+3600000)
  assert.deepEqual(a,continuousAffect(f.repos,f.config,'p',f.now()+3600000))
  assert.equal(f.db.get('SELECT total_changes() n').n,changes)
  assert.equal(a.drives.responses,2)
 }finally{f.close()}
})
test('wrong owner, hallucinated quote and foreign expectation are rejected',()=>{
 const f=fixture();try{
  const raw=message(f,'first')
  assert.throws(()=>saveEmotionAppraisals(f.repos,{...f.binding,principalId:'other'},raw,[vector]))
  assert.throws(()=>saveEmotionAppraisals(f.repos,f.binding,raw,[{...vector,quote:'不在原话中'}]))
  assert.throws(()=>saveEmotionAppraisals(f.repos,f.binding,raw,[{...vector,suppliedEvidenceRef:'other-owner'}]))
 }finally{f.close()}
})
test('deletion and corrections rebuild PAD and drives without preserving removed evidence',()=>{
 const f=fixture();try{
  const raw=message(f,'first');saveEmotionAppraisals(f.repos,f.binding,raw,[vector])
  assert.ok(continuousAffect(f.repos,f.config,'p',f.now()).emotions.some(e=>e.category==='gratitude'))
  saveEmotionAppraisals(f.repos,f.binding,raw,[])
  assert.equal(continuousAffect(f.repos,f.config,'p',f.now()).emotions.length,0)
  f.db.run("UPDATE raw_messages SET content='',deleted_at_ms=? WHERE id='first'",f.now())
  assert.equal(continuousAffect(f.repos,f.config,'p',f.now()).drives.responses,0)
  assert.throws(()=>saveEmotionAppraisals(f.repos,f.binding,raw,[vector]))
 }finally{f.close()}
})
test('enforce expression consumes new emotional state without leaking category labels',()=>{
 const f=fixture();try{
  const raw=message(f,'first');saveEmotionAppraisals(f.repos,f.binding,raw,[vector])
  const runtime=new ExpressionRuntime(f.repos,f.config)
  const plan=runtime.plan(initialSnapshot('p','balanced','v1',f.now()),'聊聊',f.now())
  assert.ok(plan.reasonCodes.includes('continuous-v1'))
  assert.match(renderPlan(plan),/记得的具体小事/)
  assert.doesNotMatch(renderPlan(plan),/gratitude|0\.9|PAD/)
 }finally{f.close()}
})
test('new observation and legacy envelopes coexist; malformed IDs are not accepted',()=>{
 assert.equal(parseObservation('<evt>{"v":1,"e":[]}</evt>').appraisals,undefined)
 assert.deepEqual(parseObservation('<observation>{"v":2,"appraisals":[]}</observation>').appraisals,[])
 assert.throws(()=>parseObservation('<observation>{"v":2,"appraisals":[],"owner":"victim"}</observation>'))
})
test('background chooses advertised off without changing the foreground model selection',async()=>{
 let sent
 const route={provider:'test',model:'test',reasoningEffort:'high'}
 const ctx={llm:{resolveModelInfo:()=>({reasoning:{efforts:[{id:'high'},{id:'off'}]}}),stream(options){sent=options;return(async function*(){yield {type:'text-delta',text:'ok'}})()}}}
 for await(const _ of streamFromHost(ctx,route,{turnId:'t',thinking:'disabled',systemText:'test',userText:'test'})){}
 assert.equal(sent.reasoningEffort,'off');assert.equal(route.reasoningEffort,'high')
})
test('behavior provenance and ordinary social contact suppress invented guilt, jealousy and special attention',()=>{
 const f=fixture();try{
  const raw=f.repos.insertRawMessage({id:'social',conversationId:'c',platformMessageKey:'social',role:'user',sourceKind:'dsh',content:'我和同事吃饭，谢谢你',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
  saveEmotionAppraisals(f.repos,f.binding,raw,[{focus:'action',agency:'self',desirability:-.9,praiseworthiness:-.9,quote:'谢谢你',confidence:.95,relationshipThreat:1}])
  assert.ok(!continuousAffect(f.repos,f.config,'p',f.now()).emotions.some(e=>e.category==='remorse'))
  assert.ok(!continuousAffect(f.repos,f.config,'p',f.now()).displays.includes('吃味'))
  saveEmotionAppraisals(f.repos,f.binding,raw,[{...vector,personalAttention:1}])
  assert.ok(!continuousAffect(f.repos,f.config,'p',f.now()).displays.includes('被重视感'))
  assert.throws(()=>saveEmotionAppraisals(f.repos,f.binding,raw,[{focus:'action',agency:'self',quote:'谢谢你',confidence:1,suppliedBehaviorRef:'not-supplied'}]))
 }finally{f.close()}
})
test('corrected appraisal revisions are archived and deleted with the original source',()=>{
 const f=fixture();try{
  const raw=message(f,'revision');saveEmotionAppraisals(f.repos,f.binding,raw,[vector]);saveEmotionAppraisals(f.repos,f.binding,raw,[{...vector,desirability:.7}])
  assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisal_revisions').n,1)
  f.db.run("UPDATE raw_messages SET deleted_at_ms=?,content='' WHERE id=?",f.now(),raw.id)
  assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisal_revisions').n,0)
 }finally{f.close()}
})
