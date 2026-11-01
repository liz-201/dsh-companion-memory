import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {gzipSync} from 'node:zlib'
import {join} from 'node:path'
import {fixture} from '../helpers/fixture.mjs'
import {exportPortable,readPortable,importPortable,stableJson} from '../../lib/storage/portable.js'
import {readEroticPolicy,setEroticPolicy,recordIntimacyStop,eroticAffect} from '../../lib/storage/erotic-interest.js'
import {saveEmotionAppraisals} from '../../lib/storage/continuous-affect.js'
import {deleteScope} from '../../lib/storage/deletion.js'
import {OwnerIdentity} from '../../lib/domain/owner-identity.js'
import {previewOwnerMerge,confirmOwnerMerge} from '../../lib/storage/owner-merge.js'

const allow={enabled:true,ownerAdultConfirmed:true,characterAdultConfirmed:true}
function source(f,id,content='别再说这种亲密话。'){return f.repos.insertRawMessage({id,conversationId:f.binding.conversationId,role:'user',sourceKind:'dsh',platformMessageKey:id,content,occurredAtMs:f.now(),observedAtMs:f.now(),deletedAtMs:null,deliveryStatus:null}).row}
function pack(f){const file=join(f.directory,randomUUID()+'.json');exportPortable(f.db,f.config,file,{includePlugin:false,nowMs:f.now()});return readPortable(file)}
function sameOwner(a,b){for(const f of[a,b])f.repos.setSetting('owner.id','same-owner',f.now())}
function merge(to,read){return importPortable(to.db,to.config,read.payload,read.checksum,{backup:false,nowMs:to.now()})}
function envelope(f,payload){const bytes=Buffer.from(stableJson(payload)),file=join(f.directory,randomUUID()+'.json');writeFileSync(file,JSON.stringify({format:'dsh-companion-transfer',version:payload.version,sha256:createHash('sha256').update(bytes).digest('hex'),data:gzipSync(bytes).toString('base64')}));return file}

test('v7 carries stop controls, never local permission, and stops an already enabled peer',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);setEroticPolicy(a.repos,'p',allow,a.now());setEroticPolicy(b.repos,'p',allow,b.now())
    const raw=source(a,'portable-stop');recordIntimacyStop(a.repos,'p',raw.id,a.now())
    const exported=pack(a)
    assert.equal(exported.payload.version,7);assert.equal(exported.payload.minReaderVersion,'0.3.0-dev.15')
    assert.equal(exported.payload.schema.find(row=>row.version===8).checksum,'3158aaa4fd3d5dc4e7dd8e37c59135cb')
    assert.equal(exported.payload.tables.intimacy_stop_events.length,1)
    assert.ok(!JSON.stringify(exported.payload).includes('ownerAdultConfirmed'))
    const previous=readEroticPolicy(b.repos,'p').revision
    merge(b,exported)
    const p=readEroticPolicy(b.repos,'p');assert.equal(p.stopped,true);assert.equal(p.enabled,false);assert.notEqual(p.revision,previous)
    assert.equal(eroticAffect(b.repos,'p',b.now()).blockReason,'owner-stop')
    const changes=b.db.get('SELECT total_changes() n').n
    assert.equal(merge(b,exported).alreadyImported,true)
    assert.equal(b.db.get('SELECT total_changes() n').n,changes)
  }finally{a.close();b.close()}
})

test('a peer never enabled remains closed even when importing positive adult evidence',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);setEroticPolicy(a.repos,'p',allow,a.now());a.advance(1000)
    const raw=source(a,'positive','我对你有性吸引，也愿意继续这类亲密话题。')
    saveEmotionAppraisals(a.repos,a.binding,raw,[{focus:'object',concern:'relationship',quote:raw.content,confidence:1,eroticCue:{kind:'interest',strength:1,quote:'我对你有性吸引'}}])
    merge(b,pack(a));assert.equal(readEroticPolicy(b.repos,'p').enabled,false);assert.equal(eroticAffect(b.repos,'p',b.now()).value,null)
  }finally{a.close();b.close()}
})

test('stop union survives stale snapshots and rejects changed content under the same id atomically',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);const old=pack(a);const raw=source(b,'local-stop');recordIntimacyStop(b.repos,'p',raw.id,b.now())
    merge(b,old);assert.equal(readEroticPolicy(b.repos,'p').stopped,true)
    const poisoned=pack(b);poisoned.payload.id=randomUUID();poisoned.payload.tables.intimacy_stop_events[0].origin_device_id='changed-origin'
    const original=pack(b);merge(a,original)
    const before=a.db.get('SELECT total_changes() n').n
    assert.throws(()=>merge(a,poisoned),/Conflicting intimacy stop/)
    // SQLite total_changes includes rolled-back statements; assert the actual authoritative row instead.
    assert.ok(a.db.get('SELECT total_changes() n').n>=before)
    assert.notEqual(a.db.get('SELECT origin_device_id FROM intimacy_stop_events').origin_device_id,'changed-origin')
    assert.equal(a.db.get('SELECT COUNT(*) n FROM portable_imports WHERE package_id=?',poisoned.payload.id).n,0)
  }finally{a.close();b.close()}
})

test('an imported stop must use its persisted original source time',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);const raw=source(a,'tampered-source-time');recordIntimacyStop(a.repos,'p',raw.id,a.now())
    const invalid=pack(a);invalid.payload.tables.intimacy_stop_events[0].created_at_ms++
    assert.throws(()=>merge(b,invalid),/source is outside owner scope/)
    assert.equal(b.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n,0)
    assert.equal(b.db.get('SELECT COUNT(*) n FROM portable_imports').n,0)
  }finally{a.close();b.close()}
})

test('a full local owner deletion also covers an older stop first learned from a stale peer',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);const raw=source(b,'previously-unknown-stop');recordIntimacyStop(b.repos,'p',raw.id,b.now())
    const stale=pack(b)
    a.advance(1000);deleteScope(a.db,a.repos,'p',{kind:'all'},a.now(),7,a.config)
    merge(a,stale)
    assert.equal(a.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n,0)
    assert.equal(readEroticPolicy(a.repos,'p').enabled,false)
  }finally{a.close();b.close()}
})

test('v6 normalizes the missing stop table without changing its old checkpoint identity',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);const old=pack(a).payload;old.id=randomUUID();old.version=6;old.formatVersion=6;old.minReaderVersion='0.3.0-dev.14';old.schema=old.schema.filter(row=>row.version<10);delete old.tables.intimacy_stop_events
    const read=readPortable(envelope(a,old));assert.deepEqual(read.payload.tables.intimacy_stop_events,[])
    merge(b,read)
    const checkpoint=JSON.parse(b.db.get('SELECT inventory_json FROM portable_checkpoints WHERE id=?',old.id).inventory_json)
    assert.equal(checkpoint.intimacy_stop_events,undefined)
    assert.equal(merge(b,read).alreadyImported,true)
    const bad=structuredClone(old);bad.tables.intimacy_stop_events=[{id:'stop',principal_id:'p',source_message_id:null,created_at_ms:a.now(),origin_device_id:'device'}]
    assert.throws(()=>readPortable(envelope(a,bad)),/require transfer version 7/)
    const v7=pack(a).payload;delete v7.tables.intimacy_stop_events
    assert.throws(()=>readPortable(envelope(a,v7)),/table missing/)
  }finally{a.close();b.close()}
})

test('message deletion preserves the stop while full owner data deletion cannot resurrect it from a stale peer',()=>{
  const a=fixture(),b=fixture()
  try{
    sameOwner(a,b);const raw=source(a,'deleted-source');recordIntimacyStop(a.repos,'p',raw.id,a.now())
    merge(b,pack(a));const stale=pack(b)
    deleteScope(a.db,a.repos,'p',{kind:'message',messageId:raw.id},a.now(),7,a.config)
    assert.equal(readEroticPolicy(a.repos,'p').stopped,true)
    merge(b,pack(a));assert.equal(b.db.get('SELECT source_message_id FROM intimacy_stop_events').source_message_id,null)
    deleteScope(a.db,a.repos,'p',{kind:'all'},a.now(),7,a.config)
    assert.equal(a.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n,0)
    merge(a,stale);assert.equal(a.db.get('SELECT COUNT(*) n FROM intimacy_stop_events').n,0)
    assert.equal(readEroticPolicy(a.repos,'p').enabled,false)
    assert.deepEqual(a.db.all('PRAGMA foreign_key_check'),[])
  }finally{a.close();b.close()}
})

test('explicit same-owner adoption remaps stop controls but does not import or promote local permission',()=>{
  const a=fixture(),b=fixture()
  try{
    const ao=new OwnerIdentity(a.repos,a.config,a.now(),'a'),bo=new OwnerIdentity(b.repos,b.config,b.now(),'b')
    a.binding=ao.binding('dsh','a','a',a.now());b.binding=bo.binding('dsh','b','b',b.now())
    const raw=source(a,'adopt-stop');recordIntimacyStop(a.repos,ao.principalId,raw.id,a.now())
    const exported=pack(a),preview=previewOwnerMerge(b.db,b.config,exported.payload,exported.checksum)
    assert.equal(preview.blockingConflicts.length,0)
    confirmOwnerMerge(b.db,b.config,exported.payload,exported.checksum,preview)
    const canonical=`${b.config.companion.id}:owner:${exported.payload.ownerId}`
    assert.equal(b.db.get('SELECT principal_id FROM intimacy_stop_events').principal_id,canonical)
    assert.equal(readEroticPolicy(b.repos,canonical).stopped,true)
    assert.equal(readEroticPolicy(b.repos,canonical).enabled,false)
    assert.deepEqual(b.db.all('PRAGMA foreign_key_check'),[])
  }finally{a.close();b.close()}
})
