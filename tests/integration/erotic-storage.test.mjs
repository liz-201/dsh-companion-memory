import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from '../helpers/fixture.mjs'
import {readEroticPolicy,setEroticPolicy,recordIntimacyStop,observeIntimacyStop,eroticAffect,recordIntimacyExpression,readIntimacyExpression,hasRecentIntimacyIntent,isEroticCharacterConfirmed} from '../../lib/storage/erotic-interest.js'
import {saveEmotionAppraisals,retractEmotionAppraisal} from '../../lib/storage/continuous-affect.js'
import {deleteScope,replayTombstones} from '../../lib/storage/deletion.js'

const allow={enabled:true,ownerAdultConfirmed:true,characterAdultConfirmed:true}
const text='我对你有性吸引，也愿意继续这类亲密话题。'
const source=(f,id,content=text,conversationId='c',sourceKind='dsh')=>f.repos.insertRawMessage({id,conversationId,role:'user',sourceKind,platformMessageKey:id,content,occurredAtMs:f.now(),observedAtMs:f.now(),deletedAtMs:null,deliveryStatus:null}).row
const vector=(raw,strength=1)=>({focus:'object',concern:'relationship',appealingness:.5,quote:raw.content,confidence:1,eroticCue:{kind:'interest',strength,quote:raw.content.split('，')[0]}})

test('local adult policy defaults closed, refuses unknown age and never writes on read',()=>{
  const f=fixture()
  try{
    const before=f.db.get('SELECT total_changes() n').n
    const p=readEroticPolicy(f.repos,'p')
    assert.equal(p.enabled,false);assert.equal(p.adultsConfirmed,false);assert.equal(p.stopped,false)
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,null)
    assert.equal(f.db.get('SELECT total_changes() n').n,before)
    assert.throws(()=>setEroticPolicy(f.repos,'p',{...allow,ownerAdultConfirmed:false},f.now()))
    assert.throws(()=>setEroticPolicy(f.repos,'p',{...allow,confirmedResume:'true'},f.now()))
    setEroticPolicy(f.repos,'p',allow,f.now())
    assert.equal(readEroticPolicy(f.repos,'p').enabled,true)
  }finally{f.close()}
})

test('stored evidence is source-deduplicated, source-timed, read-only and revised rather than added',()=>{
  const f=fixture()
  try{
    setEroticPolicy(f.repos,'p',allow,f.now());f.advance(1000)
    const raw=source(f,'interest')
    saveEmotionAppraisals(f.repos,f.binding,raw,[vector(raw),vector(raw)])
    const initial=eroticAffect(f.repos,'p',f.now())
    assert.equal(initial.value,.3);assert.deepEqual(initial.evidenceIds,[raw.id])
    const before=f.db.get('SELECT total_changes() n').n
    for(let i=0;i<1000;i++)assert.deepEqual(eroticAffect(f.repos,'p',f.now()),initial)
    assert.equal(f.db.get('SELECT total_changes() n').n,before)
    saveEmotionAppraisals(f.repos,f.binding,raw,[vector(raw,.5)])
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,.15)
    retractEmotionAppraisal(f.repos,'emotion:interest:0','p')
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,null)
  }finally{f.close()}
})

test('closed policy or group strips only the new model cue and preserves ordinary affect',()=>{
  const f=fixture()
  try{
    const raw=source(f,'disabled')
    saveEmotionAppraisals(f.repos,f.binding,raw,[vector(raw)])
    const stored=JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals WHERE source_message_id=?',raw.id).vector_json)
    assert.equal(stored.eroticCue,undefined);assert.equal(stored.appealingness,.5)
    setEroticPolicy(f.repos,'p',allow,f.now());f.advance(1000)
    f.repos.ensureConversation('g','p','group','group-fixture',f.now())
    const group=source(f,'group',text,'g')
    saveEmotionAppraisals(f.repos,{...f.binding,conversationId:'g',conversationKind:'group'},group,[vector(group)])
    assert.equal(JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals WHERE source_message_id=?',group.id).vector_json).eroticCue,undefined)
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,null)
  }finally{f.close()}
})

test('a caller cannot relabel bridge history or replace the persisted source time',()=>{
  const f=fixture()
  try{
    setEroticPolicy(f.repos,'p',allow,f.now());f.advance(1000)
    const raw=source(f,'host-time')
    assert.throws(()=>saveEmotionAppraisals(f.repos,f.binding,{...raw,occurredAtMs:raw.occurredAtMs+1},[vector(raw)]),/source owner/)
    const bridge=source(f,'relabelled-bridge',text,'c','codex-bridge')
    assert.throws(()=>saveEmotionAppraisals(f.repos,f.binding,{...bridge,sourceKind:'dsh'},[vector(bridge)]),/source owner/)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisals').n,0)
  }finally{f.close()}
})

test('a shared owner cannot carry the adult declaration into another host-selected character',()=>{
  const f=fixture()
  try{
    f.repos.setSetting('local.session-persona:c','adult-character-a',f.now())
    f.repos.ensureConversation('persona-b','p','private','persona-b',f.now())
    f.repos.setSetting('local.session-persona:persona-b','unknown-character-b',f.now())
    const initial=setEroticPolicy(f.repos,'p',{...allow,characterContextId:'adult-character-a'},f.now())
    f.advance(1000)
    assert.equal(isEroticCharacterConfirmed(f.repos,'p','c'),true)
    assert.equal(isEroticCharacterConfirmed(f.repos,'p','persona-b'),false)
    const first=source(f,'character-a')
    saveEmotionAppraisals(f.repos,f.binding,first,[vector(first)])
    const second=source(f,'character-b',text,'persona-b')
    saveEmotionAppraisals(f.repos,{...f.binding,conversationId:'persona-b'},second,[vector(second)])
    assert.equal(JSON.parse(f.db.get('SELECT vector_json FROM emotion_appraisals WHERE source_message_id=?',second.id).vector_json).eroticCue,undefined)
    recordIntimacyExpression(f.repos,'p',second.id,f.now())
    assert.equal(readIntimacyExpression(f.repos,'p'),null)
    assert.deepEqual(eroticAffect(f.repos,'p',f.now()).evidenceIds,[first.id])
    // Imported historical cues are also qualified against the source's local character mapping.
    f.db.run('UPDATE emotion_appraisals SET vector_json=? WHERE source_message_id=?',JSON.stringify(vector(second)),second.id)
    assert.deepEqual(eroticAffect(f.repos,'p',f.now()).evidenceIds,[first.id])
    f.advance(1000)
    const changed=setEroticPolicy(f.repos,'p',{...allow,characterContextId:'unknown-character-b'},f.now())
    assert.notEqual(changed.revision,initial.revision)
    assert.equal(changed.resumeEpochMs,f.now())
    assert.equal(isEroticCharacterConfirmed(f.repos,'p','c'),false)
    assert.equal(isEroticCharacterConfirmed(f.repos,'p','persona-b'),true)
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,null)
  }finally{f.close()}
})

test('real owner stop is idempotent and cannot be replaced by a switch or incomplete acknowledgement',()=>{
  const f=fixture()
  try{
    setEroticPolicy(f.repos,'p',allow,f.now());f.advance(1000)
    const stop=source(f,'stop','别再说这种亲密话。')
    assert.equal(observeIntimacyStop(f.repos,f.binding,stop,f.now()),true)
    const p=readEroticPolicy(f.repos,'p')
    assert.equal(p.enabled,false);assert.equal(p.stopped,true)
    assert.equal(eroticAffect(f.repos,'p',f.now()).blockReason,'owner-stop')
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,0)
    const changes=f.db.get('SELECT total_changes() n').n
    recordIntimacyStop(f.repos,'p',stop.id,f.now()+10000)
    assert.equal(f.db.get('SELECT total_changes() n').n,changes)
    assert.throws(()=>setEroticPolicy(f.repos,'p',allow,f.now()))
    assert.throws(()=>setEroticPolicy(f.repos,'p',{...allow,confirmedResume:true,knownStopIds:[]},f.now()))
    f.advance(1000)
    setEroticPolicy(f.repos,'p',{...allow,confirmedResume:true,knownStopIds:p.stopIds},f.now())
    assert.equal(readEroticPolicy(f.repos,'p').stopped,false)
    assert.equal(readEroticPolicy(f.repos,'p').resumeEpochMs,f.now())
  }finally{f.close()}
})

test('technical bridge, foreign owner and quoted or technical messages cannot record an intimacy stop',()=>{
  const f=fixture()
  try{
    for(const [id,value] of [['bridge','[Codex 协作回复 / mailbox stop] 别再说这种亲密话。'],['quote','“别再说这种亲密话。”'],['task','不要这样写代码。']]){
      const raw=source(f,id,value)
      assert.equal(observeIntimacyStop(f.repos,f.binding,raw,f.now(),true),false)
    }
    f.repos.ensurePrincipal('other',f.config.companion.id,'bot','other',f.now())
    f.repos.ensureConversation('other-c','other','private','other-conversation',f.now())
    const other=source(f,'foreign-stop','别再说这种亲密话。','other-c')
    assert.equal(observeIntimacyStop(f.repos,f.binding,other,f.now()),false)
    assert.throws(()=>recordIntimacyStop(f.repos,'p',other.id,f.now()))
    assert.equal(f.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n,0)
  }finally{f.close()}
})

test('deleting the original refusal removes its pointer but never resumes the module',()=>{
  const f=fixture()
  try{
    setEroticPolicy(f.repos,'p',allow,f.now());f.advance(1000)
    const raw=source(f,'deleted-stop','别再说这种亲密话。')
    recordIntimacyStop(f.repos,'p',raw.id,f.now())
    deleteScope(f.db,f.repos,'p',{kind:'message',messageId:raw.id},f.now(),7,f.config)
    assert.equal(f.repos.getRawMessage(raw.id).content,'')
    assert.equal(f.db.get('SELECT source_message_id FROM intimacy_stop_events').source_message_id,null)
    assert.equal(readEroticPolicy(f.repos,'p').stopped,true)
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,0)
  }finally{f.close()}
})

test('resume discards pre-epoch evidence while allowing new evidence and actual expression markers',()=>{
  const f=fixture()
  try{
    setEroticPolicy(f.repos,'p',allow,f.now());f.advance(1000)
    const old=source(f,'old-positive');saveEmotionAppraisals(f.repos,f.binding,old,[vector(old)])
    recordIntimacyExpression(f.repos,'p',old.id,f.now())
    assert.equal(hasRecentIntimacyIntent(f.repos,'p',f.now()),true)
    const stop=recordIntimacyStop(f.repos,'p',null,f.now())
    assert.equal(readIntimacyExpression(f.repos,'p'),null)
    f.advance(1000)
    setEroticPolicy(f.repos,'p',{...allow,confirmedResume:true,knownStopIds:stop.stopIds},f.now())
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,null)
    f.advance(1000)
    const fresh=source(f,'fresh-positive');saveEmotionAppraisals(f.repos,f.binding,fresh,[vector(fresh)])
    assert.equal(eroticAffect(f.repos,'p',f.now()).value,.3)
    recordIntimacyExpression(f.repos,'p',fresh.id,f.now())
    assert.equal(readIntimacyExpression(f.repos,'p').sourceId,fresh.id)
    f.advance(600001);assert.equal(hasRecentIntimacyIntent(f.repos,'p',f.now()),false)
  }finally{f.close()}
})

test('recorded all-deletion replay removes only its recorded controls and preserves later local decisions',()=>{
  const f=fixture()
  try{
    const first=recordIntimacyStop(f.repos,'p',null,f.now())
    f.repos.insertTombstone({id:'recorded-all',principalId:'p',selector:{kind:'all',recordedOnly:true},affectedIds:first.stopIds,createdAtMs:f.now()})
    f.advance(1000)
    setEroticPolicy(f.repos,'p',{...allow,confirmedResume:true,knownStopIds:first.stopIds},f.now())
    replayTombstones(f.db,f.repos,f.now(),f.config)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n,0)
    assert.equal(readEroticPolicy(f.repos,'p').enabled,true)
    f.advance(1000)
    const later=recordIntimacyStop(f.repos,'p',null,f.now())
    replayTombstones(f.db,f.repos,f.now(),f.config)
    assert.deepEqual(readEroticPolicy(f.repos,'p').stopIds,later.stopIds)
    assert.equal(readEroticPolicy(f.repos,'p').stopped,true)
  }finally{f.close()}
})
