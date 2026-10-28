import test from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {writeFileSync,mkdirSync} from 'node:fs'
import {fixture} from '../helpers/fixture.mjs'
import {OwnerIdentity} from '../../lib/domain/owner-identity.js'
import {continuousAffect,saveEmotionAppraisals} from '../../lib/storage/continuous-affect.js'
import {exportPortable,readPortable,importPortable} from '../../lib/storage/portable.js'
import {updatePanelSettings,loadPanelSettings} from '../../lib/panel/settings.js'
import {deleteScope} from '../../lib/storage/deletion.js'
import {doctorConfig} from '../../scripts/doctor-config.mjs'
function transfer(a,b,name){const file=join(a.directory,name);exportPortable(a.db,a.config,file,{includePlugin:false});const {payload,checksum}=readPortable(file);importPortable(b.db,b.config,payload,checksum);return payload}
test('SYNC01 v3 replays emotion and responses on another instance, synchronizes parameters, excludes images and honors deletion',()=>{
 const a=fixture(),b=fixture();a.config=structuredClone(a.config);b.config=structuredClone(b.config)
 try{
  const owner=new OwnerIdentity(a.repos,a.config),binding=owner.binding('dsh','one')
  const raw=a.repos.insertRawMessage({id:'transfer-emotion',conversationId:binding.conversationId,platformMessageKey:'one',role:'user',sourceKind:'dsh',content:'谢谢你',occurredAtMs:a.now(),observedAtMs:a.now(),deliveryStatus:null,deletedAtMs:null}).row
  saveEmotionAppraisals(a.repos,binding,raw,[{focus:'action',agency:'owner',desirability:.8,praiseworthiness:.9,quote:'谢谢你',confidence:.9}])
  updatePanelSettings(a.repos,a.config,{emotion:{contactTauHours:9},perception:{allowedApplications:['private-app']}},true,binding.principalId)
  a.repos.setSetting('local.perception.observation:secret',JSON.stringify({image:'private-image'}),a.now())
  const payload=transfer(a,b,'new.json');loadPanelSettings(b.repos,b.config)
  assert.equal(payload.version,3);assert.ok(!JSON.stringify(payload).includes('private-image'));assert.ok(!JSON.stringify(payload).includes('private-app'))
  assert.deepEqual(continuousAffect(b.repos,b.config,binding.principalId,b.now()),continuousAffect(a.repos,a.config,binding.principalId,a.now()))
  assert.equal(b.db.get("SELECT COUNT(*) n FROM response_events WHERE source_message_id='transfer-emotion'").n,1)
  deleteScope(a.db,a.repos,binding.principalId,{kind:'message',messageId:raw.id},a.now(),7,a.config)
  transfer(a,b,'deleted.json')
  assert.equal(continuousAffect(b.repos,b.config,binding.principalId,b.now()).emotions.length,0)
  assert.equal(b.db.get("SELECT COUNT(*) n FROM emotion_appraisals WHERE source_message_id='transfer-emotion'").n,0)
  assert.equal(continuousAffect(b.repos,b.config,binding.principalId,b.now()).drives.responses,0)
 }finally{a.close();b.close()}
})
test('A05 doctor accepts bundle defaults and explicit overrides, while disabled and missing bundles remain errors',()=>{
 const f=fixture();try{
  const folder=join(f.directory,'profiles','desktop');mkdirSync(folder,{recursive:true})
  const patch=join(folder,'cordis.patch.yml'),pkg=join(folder,'package.json')
  writeFileSync(patch,'[]');writeFileSync(pkg,JSON.stringify({dsh:{profile:{bundles:['dsh-companion-memory']}}}))
  assert.match(doctorConfig([],f.directory).evidence,/bundle/)
  assert.throws(()=>doctorConfig(['--config',patch],f.directory))
  writeFileSync(patch,'- id: dsh-companion-memory\n  config:\n    proactive:\n      enabled: false\n')
  assert.equal(doctorConfig([],f.directory).raw.proactive.enabled,false)
  writeFileSync(patch,'- remove: dsh-companion-memory\n');assert.throws(()=>doctorConfig([],f.directory))
  writeFileSync(pkg,'{}');writeFileSync(patch,'[]');assert.throws(()=>doctorConfig([],f.directory))
 }finally{f.close()}
})
