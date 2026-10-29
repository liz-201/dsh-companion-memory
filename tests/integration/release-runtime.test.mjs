import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, insult } from '../helpers/fixture.mjs'
import { ExpressionRuntime } from '../../lib/expression/runtime.js'
import { initialSnapshot } from '../../lib/domain/affect-reducer.js'
import { saveEmotionAppraisals } from '../../lib/storage/continuous-affect.js'
import { exportPortable, readPortable, importPortable } from '../../lib/storage/portable.js'
import { repairBridgeAffect } from '../../lib/runtime/repair-bridge-affect.js'

const insert = (f,id,content) => f.repos.insertRawMessage({id,conversationId:'c',platformMessageKey:id,role:'user',sourceKind:'qq',content,occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row

test('real expression runtime applies regulation to stored appraisal evidence before rendering and guard', () => {
  const f=fixture()
  try {
    const source=insert(f,'anger','你刚才确实在侮辱我')
    saveEmotionAppraisals(f.repos,f.binding,source,[{focus:'action',agency:'owner',affectedParty:'self',desirability:-.99,praiseworthiness:-.99,quote:source.content,relevance:1,confidence:1}])
    const runtime=new ExpressionRuntime(f.repos,f.config)
    const state=initialSnapshot('p','balanced',f.config.affect.ruleVersion,f.now())
    const result=runtime.plan(state,'说说刚才的事',f.now())
    assert.ok(result.reasonCodes.includes('regulate:impulse-contained'))
    assert.equal(result.playfulness,0)
    const support=runtime.plan(state,'我很难过，插件也报错了',f.now())
    assert.equal(support.stance,'supportive')
    assert.ok(support.reasonCodes.includes('regulate:support-focus'))
    const json=runtime.plan(state,'只输出JSON，值为1.25',f.now())
    assert.equal(json.mode,'structured')
    assert.ok(!json.reasonCodes.some(code=>code.startsWith('regulate:')))
    assert.equal(f.repos.getSnapshot('p'),undefined)
  }finally{f.close()}
})

test('import cannot let a later technical bridge row advance the persisted latest human sequence', () => {
  const a=fixture(),b=fixture()
  try {
    for(const f of[a,b])f.repos.setSetting('owner.id','same-owner',f.now())
    const human=insert(a,'human-import','今天聊聊日常')
    insert(a,'bridge-import','[Codex 协作回复 / mailbox release] 完成代码审查')
    const file=join(a.directory,'source-policy.companion.json')
    exportPortable(a.db,a.config,file,{includePlugin:false,nowMs:a.now()})
    const {payload,checksum}=readPortable(file)
    importPortable(b.db,b.config,payload,checksum,{backup:false,nowMs:b.now()})
    const seq=b.repos.getRawMessage(human.id).seq
    assert.equal(b.repos.latestInboundSeq('c'),seq)
    assert.equal(b.db.get("SELECT latest_inbound_seq n FROM conversations WHERE id='c'").n,seq)
  }finally{a.close();b.close()}
})

test('historical bridge affect with no appraisal row is backed up and retracted without deleting original history', async () => {
  const f=fixture({events:[insult]})
  try {
    await f.turn('你这个笨蛋就是不会做事')
    const source=f.db.get("SELECT id,content FROM raw_messages WHERE role='user' ORDER BY seq LIMIT 1")
    f.db.run('UPDATE affect_events SET appraisal_id=NULL')
    f.db.run('DELETE FROM appraisals')
    f.db.run('UPDATE raw_messages SET content=? WHERE id=?','[Codex 协作回复 / mailbox historical] '+source.content,source.id)
    const report=repairBridgeAffect(f.repos,f.config,f.now())
    assert.equal(report.events,1)
    assert.ok(existsSync(report.backup))
    assert.equal(f.db.get("SELECT COUNT(*) n FROM affect_events WHERE status='retracted'").n,1)
    assert.ok(f.repos.getRawMessage(source.id).content.includes('historical'))
    assert.equal(f.snapshot().relationship.grievance,0)
    assert.equal(repairBridgeAffect(f.repos,f.config,f.now()).events,0)
  }finally{f.close()}
})
