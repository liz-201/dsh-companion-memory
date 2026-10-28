import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from '../helpers/fixture.mjs'
import {continuousAffect} from '../../lib/storage/continuous-affect.js'
import {BackgroundQueue} from '../../lib/runtime/background-queue.js'
import {recoverCapabilityExtractions} from '../../lib/runtime/extraction-recovery.js'
const envelope='<observation>{"v":2,"legacy":{"v":1,"e":[]},"appraisals":[{"focus":"action","agency":"owner","desirability":0.8,"praiseworthiness":0.8,"personalAttention":0.9,"quote":"谢谢你","confidence":0.95}]}</observation>'
test('EM04 before-reply evaluates the current persisted source before the foreground model and consumes it once',async()=>{
 const f=fixture({config:{emotion:{mode:'before-reply'}},callModel:async function*(request){yield{text:request.turnId.startsWith('before-reply:')?envelope:'<say>收到</say><evt>{"v":1,"e":[]}</evt>'}}})
 try{
  await f.turn('你还记得那件事，谢谢你')
  assert.equal(f.requests.length,2);assert.ok(f.requests[0].turnId.startsWith('before-reply:'));assert.equal(f.requests[0].thinking,'disabled')
  assert.ok(continuousAffect(f.repos,f.config,'p',f.now()).displays.includes('被重视感'))
  const raw=f.repos.getRawMessage('c:in-0');await f.coordinator.requestObservation(f.binding,raw)
  assert.equal(f.requests.length,2);assert.equal(continuousAffect(f.repos,f.config,'p',f.now()).drives.responses,1)
 }finally{f.close()}
})
test('EM04 pre-evaluation timeout permits the reply, rejects late writes and retains unknown usage',async()=>{
 const f=fixture({config:{emotion:{mode:'before-reply',timeoutMs:100}},callModel:async function*(request){if(request.turnId.startsWith('before-reply:')){await new Promise(r=>setTimeout(r,180));yield{text:envelope}}else yield{text:'<say>收到</say><evt>{"v":1,"e":[]}</evt>'}}})
 try{
  await f.turn('谢谢你');assert.equal(f.sends.length,1)
  await new Promise(r=>setTimeout(r,120))
  assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisals').n,0)
  assert.equal(f.ledger.summary().evaluation.calls,1)
 }finally{f.close()}
})
test('EM04 zero appraisals completes extraction without a second call; repeated requests share one flight',async()=>{
 let calls=0
 const f=fixture({callModel:async function*(){calls++;await new Promise(r=>setTimeout(r,10));yield{text:'<observation>{"v":2,"appraisals":[]}</observation>'}}})
 try{
  const raw=f.repos.insertRawMessage({id:'zero',conversationId:'c',platformMessageKey:'zero',role:'user',sourceKind:'dsh',content:'hello',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
  await Promise.all([f.coordinator.requestObservation(f.binding,raw),f.coordinator.requestObservation(f.binding,raw)])
  await f.coordinator.requestObservation(f.binding,raw)
  assert.equal(calls,1);assert.equal(continuousAffect(f.repos,f.config,'p',f.now()).drives.responses,1)
 }finally{f.close()}
})
test('pre-reply wait remains bounded when a longer background observation already owns the flight',{timeout:3000},async()=>{
 let release
 const gate=new Promise(r=>release=r)
 const f=fixture({config:{emotion:{mode:'before-reply',timeoutMs:100}},callModel:async function*(){await gate;yield{text:'<observation>{"v":2,"appraisals":[]}</observation>'}}})
 try{
  const raw=f.repos.insertRawMessage({id:'shared',conversationId:'c',platformMessageKey:'shared',role:'user',sourceKind:'dsh',content:'hello',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
  const background=f.coordinator.requestObservation(f.binding,raw)
  await f.coordinator.observeBeforeReply(f.binding,raw)
  assert.equal(f.requests.length,1);release();await background
  assert.equal(f.ledger.summary().background.calls,1)
 }finally{release();f.close()}
})
test('late imported capability failures recover once per job, including after the initial recovery pass',()=>{
 const f=fixture(),queue=new BackgroundQueue(f.repos,f.metrics)
 try{
  for(let i=0;i<2;i++){
   f.repos.insertRawMessage({id:`cap${i}`,conversationId:'c',platformMessageKey:`cap${i}`,role:'user',sourceKind:'dsh',content:'hello',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null})
   queue.enqueue('extract',{messageId:`cap${i}`},{dedupKey:`cap${i}`,availableAtMs:f.now(),nowMs:f.now()});f.repos.finishJob(`extract:cap${i}`,'failed','当前模型没有声明关闭思考的选项')
   assert.equal(recoverCapabilityExtractions(f.repos,f.now()),1)
   f.repos.finishJob(`extract:cap${i}`,'failed','当前模型没有声明关闭思考的选项')
   assert.equal(recoverCapabilityExtractions(f.repos,f.now()),0)
  }
 }finally{f.close()}
})
