import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {resolveConfig} from '../lib/config.js'
import {openDatabase} from '../lib/storage/database.js'
import {migrate} from '../lib/storage/migrations.js'
import {PRESETS} from '../lib/domain/affect-reducer.js'
import {Repositories} from '../lib/storage/repositories.js'
import {continuousAffect,saveEmotionAppraisals} from '../lib/storage/continuous-affect.js'
const config=resolveConfig({}),directory=mkdtempSync(join(tmpdir(),'companion-continuous-replay-')),start=1760000000000
const db=openDatabase({...config.storage,directory},true);migrate(db,{now:start})
const repos=new Repositories(db);repos.ensureCompanion(config.companion.id,'fixture',PRESETS.balanced,start);repos.ensurePrincipal('p',config.companion.id,'bot','owner',start);repos.ensureConversation('c','p','private','private:fixture',start)
const f={config,db,repos,now:()=>start,binding:{companionId:config.companion.id,botAccountId:'bot',userId:'owner',principalId:'p',conversationId:'c',conversationKind:'private',visibility:'private'},close(){db.close();if(!resolve(directory).startsWith(resolve(tmpdir())+sep)||!directory.includes('companion-continuous-replay-'))throw Error('Unsafe cleanup');rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50})}}
const turns=10000,messages=[]
const percentile=(samples,p)=>[...samples].sort((a,b)=>a-b)[Math.min(samples.length-1,Math.floor(samples.length*p))]
try{
 f.db.transaction(()=>{
  for(let i=0;i<turns;i++)messages.push(f.repos.insertRawMessage({id:`continuous:${i}`,conversationId:'c',platformMessageKey:String(i),role:'user',sourceKind:i%2?'qq':'dsh',content:'谢谢你，记得这件事',occurredAtMs:start+i*60000,observedAtMs:start+i*60000,deliveryStatus:null,deletedAtMs:null}).row)
 })
 const at=start+turns*60000,before=continuousAffect(f.repos,f.config,'p',at).drives
 // Late, reverse-order observations are not new owner responses.
 for(let i=turns-1;i>=0;i-=4)saveEmotionAppraisals(f.repos,f.binding,messages[i],[{focus:'action',agency:'owner',desirability:.8,praiseworthiness:.8,personalAttention:.8,quote:'谢谢你',confidence:.9}])
 const state=continuousAffect(f.repos,f.config,'p',at)
 assert.deepEqual(state.drives,before)
 assert.deepEqual(state,continuousAffect(new Repositories(f.db),f.config,'p',at))
 const samples=[],cold=[]
 for(let i=0;i<100;i++){const t=performance.now();assert.deepEqual(continuousAffect(f.repos,f.config,'p',at),state);samples.push(performance.now()-t)}
 for(let i=0;i<10;i++){const t=performance.now();continuousAffect(new Repositories(f.db),f.config,'p',at);cold.push(performance.now()-t)}
 const changes=f.db.get('SELECT total_changes() n').n
 for(const dt of [1,3600000,86400000,1e12]){const future=continuousAffect(f.repos,f.config,'p',at+dt);assert.ok(future.drives.contact>=0&&future.drives.contact<=1)}
 assert.equal(f.db.get('SELECT total_changes() n').n,changes)
 f.db.transaction(()=>{for(let i=0;i<turns;i+=100)f.db.run("UPDATE raw_messages SET content='',deleted_at_ms=? WHERE id=?",at,`continuous:${i}`)})
 assert.equal(continuousAffect(f.repos,f.config,'p',at).drives.responses,9900)
 const report={at:new Date().toISOString(),turns,appraisals:2500,lateReplayEqual:true,readWrites:0,deletedResponses:100,warmMs:{p50:percentile(samples,.5),p95:percentile(samples,.95)},coldMs:{p50:percentile(cold,.5),p95:percentile(cold,.95)},modelCalls:0}
 mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/continuous-replay-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
 assert.ok(report.warmMs.p95<50,'Warm full-state projection p95 stays below 50ms')
}finally{f.close()}
