import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../helpers/fixture.mjs'
import { continuousAffect } from '../../lib/storage/continuous-affect.js'
import { ExpressionRuntime } from '../../lib/expression/runtime.js'
import { renderPlan } from '../../lib/expression/policy.js'
import { estimateTokens } from '../../lib/runtime/context-budget.js'
import { parseObservation } from '../../lib/runtime/emotion-observation.js'
import { attendAffect } from '../../lib/domain/affect-attention.js'
import { parseAppraisals } from '../../lib/domain/emotion-appraisal.js'
import { saveEmotionAppraisals } from '../../lib/storage/continuous-affect.js'
import { exportPortable, readPortable, importPortable } from '../../lib/storage/portable.js'
import { deleteScope } from '../../lib/storage/deletion.js'
import { join } from 'node:path'

const cases = [
  ['interest', '你一直好奇那颗新发现的星星是怎么形成的', {novelty:.8,knowledgeGap:.9}, .6, 'topic', '星星', /未知|探索/],
  ['surprise', '那颗星星居然突然变成两颗了', {novelty:.9}, undefined, 'topic', '星星', /意外|惊讶/],
  ['amusement', '你也觉得这只倒着走的企鹅很好笑', {incongruity:.9}, .7, 'topic', '企鹅', /笑点/],
  ['awe', '你第一次见到这片如此壮美的星云', {novelty:.8,aestheticImpact:.9}, .7, 'topic', '星云', /壮美|惊叹/],
  ['calm', '这件你担心的事已经安全解决，可以放心了', {safety:.9}, .7, 'self', undefined, /安稳|松弛/],
  ['boredom', '这个话题已经重复十遍了，你也说了实在没意思', {monotony:.9}, -.6, 'topic', '话题', /重复|具体角度/],
  ['frustration', '你想修好项目却接连失败，一直被这个错误卡住', {goalBlockage:.9}, -.7, 'topic', '项目', /受阻|不甘/],
  ['grief', '你在意的那份共同记录永久丢失，再也找不回来了', {loss:.9,permanence:.9,attachment:.8}, -.8, 'self', undefined, /失去|释怀/],
  ['loneliness', '你说过在意的那个朋友明确离开了，以后不再与你交谈', {separation:.9,attachment:.8}, -.7, 'self', undefined, /疏离|沉默/],
  ['longing', '你一直牵挂的那位朋友搬走了，你还记着他', {separation:.8,attachment:.9}, -.1, 'self', undefined, /牵挂/],
  ['tenderness', '我记得你说过的小事，今天特意回来陪你聊', {attachment:.9}, .7, 'relationship', undefined, /关心|柔和/],
  ['nostalgia', '我们又说起上次一起看星星的那段对话，你一直珍惜它', {recollection:.9,attachment:.8}, .5, 'relationship', undefined, /回忆|细节/],
  ['disgust', '那个腐烂的苹果让你觉得很反感', {aversion:.9}, -.5, 'topic', '苹果', /反感/],
  ['envy', '你也想得到这个奖，却看见别人得到了', {comparison:.9}, -.6, 'self', undefined, /比较|复杂/],
  ['anxiety', '你担心重要的记录可能丢失，现在还无法控制结果', {}, -.8, 'self', undefined, /不确定|担心/],
  ['compassion', '我失去了很重要的东西，你之前也一直关心我的处境', {}, undefined, 'owner', undefined, /处境|困难/],
  ['bittersweet', '又想起我们那段珍惜的对话，可惜那份记录已经不在了', {recollection:.9,attachment:.8}, -.6, 'relationship', undefined, /并存|缘由/],
]

for (const [kind,text,situation,desirability,concern,topic,expression] of cases) {
  test(`real observer -> persistence -> replay -> bounded expression: ${kind}`, async () => {
    const vector={focus:'event',affectedParty:'self',quote:text,confidence:.96,relevance:.95,concern,situation,...(topic?{topic}:{}),...(desirability===undefined?{unresolved:['desirability']}:{desirability})}
    if(kind==='disgust')Object.assign(vector,{focus:'object',appealingness:-.8})
    if(kind==='amusement'||kind==='awe') {Object.assign(vector,{focus:'object',appealingness:.8});delete vector.desirability}
    if(kind==='envy')Object.assign(vector,{desirabilityForOther:.8})
    if(kind==='anxiety')Object.assign(vector,{prospect:'pending',likelihood:.6,controllability:.1})
    if(kind==='compassion')Object.assign(vector,{affectedParty:'owner',desirabilityForOther:-.8,likingForOther:.8})
    const f=fixture({callModel:async function*(request){
      assert.equal(JSON.parse(request.userText).userMessage,text)
      yield{text:`<observation>${JSON.stringify({v:3,legacy:{v:1,e:[]},appraisals:[vector]})}</observation>`}
    }})
    try {
      const row=f.repos.insertRawMessage({id:'human-source',conversationId:'c',platformMessageKey:'human-source',role:'user',sourceKind:'dsh',content:text,occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
      await f.coordinator.requestObservation(f.binding,row)
      const state=continuousAffect(f.repos,f.config,'p',f.now())
      assert.ok(state.experiences.some(e=>e.kind===kind),kind)
      assert.equal(f.sends.length,0,'observer must never reply to the user')
      assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisals').n,1)
      const runtime=new ExpressionRuntime(f.repos,f.config)
      const plan=runtime.plan(f.snapshot(),topic?`聊聊${topic}`:'你现在怎么样',f.now())
      assert.match(renderPlan(plan),expression)
      assert.ok(estimateTokens(renderPlan(plan))<=150)
      assert.deepEqual(continuousAffect(f.repos,f.config,'p',f.now()),state,'read frequency cannot amplify feelings')
      // Removing the distinguishing evidence must remove this experience even though
      // the same emotional words and source message remain in the database.
      const suppressed=structuredClone(vector)
      const axis={interest:'knowledgeGap',surprise:'novelty',amusement:'incongruity',awe:'aestheticImpact',calm:'safety',boredom:'monotony',frustration:'goalBlockage',grief:'permanence',loneliness:'separation',longing:'attachment',tenderness:'attachment',nostalgia:'recollection',disgust:'aversion',envy:'comparison',bittersweet:'recollection'}[kind]
      if(axis)delete suppressed.situation[axis]
      if(kind==='anxiety')delete suppressed.controllability
      if(kind==='compassion')delete suppressed.likingForOther
      saveEmotionAppraisals(f.repos,f.binding,row,[suppressed])
      assert.ok(!continuousAffect(f.repos,f.config,'p',f.now()).experiences.some(e=>e.kind===kind),'unknown evidence cannot activate a feeling')
      saveEmotionAppraisals(f.repos,f.binding,row,[vector])
      f.advance(24*3600000)
      assert.ok(!continuousAffect(f.repos,f.config,'p',f.now()).experiences.some(e=>e.kind===kind),'transient experiences must fade')
    } finally {f.close()}
  })
}

test('v3 omitted axes request correction; explicit unknown and old sparse records remain compatible',()=>{
  const wrap=a=>`<observation>${JSON.stringify({v:3,appraisals:[a]})}</observation>`
  const base={focus:'object',concern:'topic',topic:'书',quote:'这本书到了',confidence:.9}
  assert.throws(()=>parseObservation(wrap(base)),/appealingness/)
  assert.equal(parseObservation(wrap({...base,unresolved:['appealingness']})).appraisals.length,1)
  assert.equal(parseObservation(`<observation>${JSON.stringify({v:2,appraisals:[{focus:'object',quote:'书',confidence:.9}]})}</observation>`).appraisals.length,1)
  assert.throws(()=>parseObservation('<observation>{"v":"3","appraisals":[]}</observation>'))
  assert.deepEqual(parseObservation(`<observation>${JSON.stringify({v:3,appraisals:[base],unresolved:['appealingness']})}</observation>`).appraisals[0].unresolved,['appealingness'])
  assert.throws(()=>parseObservation(`<observation>${JSON.stringify({v:3,appraisals:[base],unresolved:['principalId']})}</observation>`))
})

test('gratitude and anger can coexist; repairing a source does not erase unrelated gratitude',async()=>{
  const text='我确实帮你找回了资料，但也故意骗了你。'
  const positive={focus:'action',agency:'owner',affectedParty:'self',concern:'relationship',quote:text,confidence:.95,desirability:.8,praiseworthiness:.8}
  const negative={...positive,desirability:-.8,praiseworthiness:-.8}
  const f=fixture({callModel:async function*(){yield{text:`<observation>${JSON.stringify({v:3,appraisals:[positive,negative]})}</observation>`}}})
  try{
    const row=f.repos.insertRawMessage({id:'mixed',conversationId:'c',platformMessageKey:'mixed',role:'user',sourceKind:'dsh',content:text,occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
    await f.coordinator.requestObservation(f.binding,row)
    const state=continuousAffect(f.repos,f.config,'p',f.now())
    assert.ok(state.emotions.some(e=>e.category==='anger'))
    assert.ok(state.emotions.some(e=>e.category==='gratitude'))
    assert.match(renderPlan(new ExpressionRuntime(f.repos,f.config).plan(f.snapshot(),'说说刚才的事',f.now())),/并存/)
    saveEmotionAppraisals(f.repos,f.binding,row,[positive])
    const repaired=continuousAffect(f.repos,f.config,'p',f.now())
    assert.ok(!repaired.emotions.some(e=>e.category==='anger'))
    assert.ok(repaired.emotions.some(e=>e.category==='gratitude'))
  }finally{f.close()}
})

test('a dislike of software never turns into hostility toward the user on another topic',async()=>{
  const f=fixture({callModel:async function*(){yield{text:'<observation>{"v":3,"appraisals":[{"focus":"object","concern":"topic","topic":"软件","quote":"这个软件让你讨厌","confidence":0.95,"appealingness":-0.9,"situation":{"aversion":0.9}}]}</observation>'}}})
  try{
    const row=f.repos.insertRawMessage({id:'topic',conversationId:'c',platformMessageKey:'topic',role:'user',sourceKind:'dsh',content:'这个软件让你讨厌',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
    await f.coordinator.requestObservation(f.binding,row)
    const state=continuousAffect(f.repos,f.config,'p',f.now())
    assert.ok(state.emotions.some(e=>e.category==='hate'))
    const unrelated=attendAffect(state,'今天天气怎么样')
    assert.equal(unrelated.emotions.length,0)
    const same=attendAffect(state,'你怎么看这个软件')
    assert.ok(same.experiences.some(e=>e.kind==='disgust'))
    assert.equal(same.ownerDirectedAnger,0)
    const plan=new ExpressionRuntime(f.repos,f.config).plan(f.snapshot(),'你怎么看这个软件',f.now())
    assert.notEqual(plan.stance,'firm')
  }finally{f.close()}
})

test('a meaningful one-character topic can be recalled without matching generic pronouns',()=>{
  const context={sourceId:'book',atMs:0,concern:'topic',topic:'书',emotions:[{category:'love',intensity:.8}],experiences:[],displays:[]}
  const state={contexts:[context],emotions:context.emotions,displays:[],pad:{emotion:{pleasure:.4,arousal:.1,dominance:0},mood:{pleasure:0,arousal:0,dominance:0},controlKnown:false}}
  assert.equal(attendAffect(state,'再聊聊这本书').emotions.length,1)
  assert.equal(attendAffect(state,'我下班了').emotions.length,0)
})

test('extended appraisal fields reject unbounded, invented and server-owned material',()=>{
  const base={focus:'event',quote:'hello',confidence:.9}
  for(const more of [{situation:{arbitrary:1}},{situation:{loss:NaN}},{situation:{loss:2}},{situation:['loss']},{topic:'x'.repeat(81)},{concern:'everyone'},{unresolved:['principalId']}])assert.throws(()=>parseAppraisals([{...base,...more}]))
  const nested=parseAppraisals([{...base,situation:{goalBlockage:.9,helplessness:.7}}])[0]
  assert.equal(nested.helplessness,.7)
  assert.deepEqual(nested.situation,{goalBlockage:.9})
  assert.throws(()=>parseAppraisals([{...base,helplessness:.2,situation:{helplessness:.8}}]),/conflicting/)
})

test('the host rejects invented topic evidence without partially saving a vector set',async()=>{
  const f=fixture({callModel:async function*(){yield{text:'<observation>{"v":3,"appraisals":[{"focus":"object","concern":"topic","topic":"不存在的对象","quote":"这本书","confidence":0.9,"appealingness":0.8}]}</observation>'}}})
  try{
    const row=f.repos.insertRawMessage({id:'bad-topic',conversationId:'c',platformMessageKey:'bad-topic',role:'user',sourceKind:'dsh',content:'这本书',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
    await assert.rejects(f.coordinator.requestObservation(f.binding,row),/topic/)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisals').n,0)
  }finally{f.close()}
})

test('embarrassment needs an actual prior assistant behavior and reaches the generated plan',async()=>{
  const text='你刚才把2加2说成5，大家都看见了。'
  const f=fixture({callModel:async function*(){yield{text:`<observation>${JSON.stringify({v:3,appraisals:[{focus:'action',agency:'self',concern:'self',quote:text,confidence:.95,desirability:-.7,praiseworthiness:-.7,situation:{exposure:.9},suppliedBehaviorRef:'assistant-error'}]})}</observation>`}}})
  try{
    f.repos.insertRawMessage({id:'assistant-error',conversationId:'c',platformMessageKey:'assistant-error',role:'assistant',sourceKind:'dsh',content:'2加2等于5',occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:'accepted',deletedAtMs:null})
    const row=f.repos.insertRawMessage({id:'exposure',conversationId:'c',platformMessageKey:'exposure',role:'user',sourceKind:'dsh',content:text,occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
    await f.coordinator.requestObservation(f.binding,row)
    assert.ok(continuousAffect(f.repos,f.config,'p',f.now()).experiences.some(e=>e.kind==='embarrassment'))
    assert.match(renderPlan(new ExpressionRuntime(f.repos,f.config).plan(f.snapshot(),'刚才那道题',f.now())),/过失|失误|窘迫/)
    deleteScope(f.db,f.repos,'p',{kind:'message',messageId:'assistant-error'},f.now(),7,f.config)
    assert.equal(continuousAffect(f.repos,f.config,'p',f.now()).experiences.length,0,'removing evidence must remove derived embarrassment')
  }finally{f.close()}
})

test('extended feelings survive v7 sync, repeated import, correction and deletion without revival',()=>{
  const a=fixture(),b=fixture()
  try{
    for(const f of[a,b])f.repos.setSetting('owner.id','same-owner',f.now())
    const text='你想修好项目，却一直被错误卡住'
    const raw=a.repos.insertRawMessage({id:'sync-frustration',conversationId:'c',platformMessageKey:'sync-frustration',role:'user',sourceKind:'dsh',content:text,occurredAtMs:a.now(),observedAtMs:a.now(),deliveryStatus:null,deletedAtMs:null}).row
    saveEmotionAppraisals(a.repos,a.binding,raw,[{focus:'event',affectedParty:'self',concern:'topic',topic:'项目',quote:text,confidence:.95,desirability:-.8,situation:{goalBlockage:.9}}])
    const file=join(a.directory,'rich.json')
    exportPortable(a.db,a.config,file,{includePlugin:false})
    const {payload,checksum}=readPortable(file)
    assert.equal(payload.version,7)
    assert.equal(payload.minReaderVersion,'0.3.0-dev.15')
    importPortable(b.db,b.config,payload,checksum,{backup:false})
    assert.equal(importPortable(b.db,b.config,payload,checksum,{backup:false}).alreadyImported,true)
    const principal=b.db.get("SELECT principal_id FROM emotion_appraisals WHERE source_message_id='sync-frustration'").principal_id
    assert.ok(continuousAffect(b.repos,b.config,principal,b.now()).experiences.some(e=>e.kind==='frustration'))
    deleteScope(b.db,b.repos,principal,{kind:'message',messageId:raw.id},b.now(),7,b.config)
    importPortable(b.db,b.config,payload,checksum,{backup:false})
    assert.equal(continuousAffect(b.repos,b.config,principal,b.now()).experiences.length,0)
  }finally{a.close();b.close()}
})

test('correcting an appraisal removes its previous facets rather than adding another feeling',()=>{
  const f=fixture()
  try{
    const text='这本书让我有些怀念'
    const raw=f.repos.insertRawMessage({id:'revise',conversationId:'c',platformMessageKey:'revise',role:'user',sourceKind:'dsh',content:text,occurredAtMs:f.now(),observedAtMs:f.now(),deliveryStatus:null,deletedAtMs:null}).row
    const vector={focus:'object',concern:'topic',topic:'书',quote:text,confidence:.95,appealingness:.6,situation:{recollection:.9,attachment:.8}}
    saveEmotionAppraisals(f.repos,f.binding,raw,[vector])
    assert.ok(continuousAffect(f.repos,f.config,'p',f.now()).experiences.some(e=>e.kind==='nostalgia'))
    saveEmotionAppraisals(f.repos,f.binding,raw,[{...vector,situation:{}}])
    assert.equal(continuousAffect(f.repos,f.config,'p',f.now()).experiences.length,0)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM emotion_appraisal_revisions').n,1)
  }finally{f.close()}
})
