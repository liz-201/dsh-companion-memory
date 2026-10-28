import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture, appreciation } from '../helpers/fixture.mjs'
import { saveEmotionAppraisals, continuousAffect, retractEmotionAppraisal } from '../../lib/storage/continuous-affect.js'
import { exportPortable, readPortable, importPortable } from '../../lib/storage/portable.js'
import { parseAppraisals } from '../../lib/domain/emotion-appraisal.js'
import { qualifiedOwnerPull } from '../../lib/domain/relationship-evidence.js'

const raw = (f,id,text='我想和你多聊一会') => f.repos.insertRawMessage({id,conversationId:'c',role:'user',sourceKind:'qq',platformMessageKey:id,content:text,occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
const vector = (source,pull=.8) => ({focus:'object',agency:'owner',appealingness:.8,pull,quote:source.content,confidence:.95})

test('relationship replay is source-bound, independent from liking, stable on reread and revised rather than accumulated', async () => {
  const f=fixture()
  try {
    const source=raw(f,'approach')
    const read=()=>continuousAffect(f.repos,f.config,'p',f.now())
    saveEmotionAppraisals(f.repos,f.binding,source,[{...vector(source),pull:undefined}])
    assert.equal(read().relationship.desire,0)
    saveEmotionAppraisals(f.repos,f.binding,source,[vector(source),vector(source)])
    const initial=read()
    assert.ok(initial.relationship.desire>0)
    assert.equal(initial.relationship.sourceCount,1)
    assert.equal(initial.relationship.intimacy,.15)
    const changes=f.db.get('SELECT total_changes() AS n').n
    for(let i=0;i<1000;i++)assert.deepEqual(read(),initial)
    assert.equal(f.db.get('SELECT total_changes() AS n').n,changes)
    saveEmotionAppraisals(f.repos,f.binding,source,[vector(source,.4)])
    assert.ok(read().relationship.desire<initial.relationship.desire)
    retractEmotionAppraisal(f.repos,'emotion:approach:0','p')
    assert.equal(read().relationship.desire,0)
    await f.coordinator.observe(f.binding,source,{v:1,e:[appreciation]})
    const closeness=read().relationship
    assert.ok(closeness.intimacy>.15)
    f.db.run('UPDATE raw_messages SET deleted_at_ms=? WHERE id=?',f.now(),source.id)
    assert.equal(read().relationship.intimacy,.15)
    assert.equal(read().relationship.desire,0)
  }finally{f.close()}
})

test('owner motivation gate rejects fiction, third parties, work instructions and sign disagreement', () => {
  const examples=[['我想和你多聊一会',.8,.8],['别再主动联系我',-.8,-.8],['别再主动联系我',.8,undefined],['他说“我想和你多聊一会”',.8,undefined],['如果我想和你多聊一会',.8,undefined],['我想和你实现插件同步',.8,undefined],['我喜欢这本书',.8,undefined]]
  for(const [text,pull,expected] of examples){const a={focus:'object',quote:text,confidence:.9,pull};assert.equal(qualifiedOwnerPull(a,text,true),expected);assert.equal(qualifiedOwnerPull(a,text,false),undefined)}
  assert.throws(()=>parseAppraisals([{focus:'object',quote:'q',confidence:.9,pull:1.01}]))
  for(const source of ['我不想和你聊天，别把我想和你聊聊这种说法当真','别主动联系我，我想和你聊聊但现在不行'])assert.equal(qualifiedOwnerPull({focus:'object',quote:'我想和你聊聊',confidence:.95,pull:.8},source,true),undefined)
})

test('format five carries explicit motivation and original migration checksums across two real databases', () => {
  const a=fixture(),b=fixture()
  try {
    a.repos.setSetting('owner.id','same-owner',a.now());b.repos.setSetting('owner.id','same-owner',b.now())
    const source=raw(a,'portable-approach')
    saveEmotionAppraisals(a.repos,a.binding,source,[vector(source)])
    const path=join(a.directory,'relationship.companion.json')
    exportPortable(a.db,a.config,path,{includePlugin:false,nowMs:a.now()})
    const {payload,checksum}=readPortable(path)
    assert.equal(payload.version,5);assert.equal(payload.minReaderVersion,'0.3.0-dev.10')
    assert.equal(payload.schema.find(row=>row.version===8).checksum,'3158aaa4fd3d5dc4e7dd8e37c59135cb')
    importPortable(b.db,b.config,payload,checksum,{backup:false,nowMs:a.now()})
    assert.deepEqual(continuousAffect(b.repos,b.config,'p',a.now()).relationship,continuousAffect(a.repos,a.config,'p',a.now()).relationship)
    const before=b.db.get('SELECT total_changes() AS n').n
    assert.equal(importPortable(b.db,b.config,payload,checksum,{backup:false}).alreadyImported,true)
    assert.equal(b.db.get('SELECT total_changes() AS n').n,before)
  }finally{a.close();b.close()}
})
