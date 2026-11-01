import test from 'node:test'
import assert from 'node:assert/strict'
import { qualifyEroticCue, isIntimacyStop } from '../../lib/domain/erotic-evidence.js'
import { projectEroticInterest } from '../../lib/domain/erotic-interest.js'

const open = { isHuman: true, isPrivate: true, enabled: true, adultsConfirmed: true }
const policy = { enabled: true, adultsConfirmed: true, stopped: false, epochMs: 0 }
const now = 1793503500000
const vector = (quote, kind = 'interest') => ({ focus: 'object', concern: 'relationship', quote,
  confidence: .95, eroticCue: { kind, quote, ...(kind === 'interest' ? {strength:1} : {}) } })
const currentInvitation = '我愿意继续成人亲密话题'
const cueFor = (clause, suffix = currentInvitation) => qualifyEroticCue(vector(clause), `${clause}，${suffix}`, open)
const event = (extra = {}) => ({sourceId:'same-source',atMs:now,strength:1,revision:1,status:'active',...extra})

test('a model stop proposal still requires a real private owner source', () => {
  const text = '不要再说这种亲密话'
  for(const context of [{...open,isHuman:false},{...open,isPrivate:false}]) {
    assert.equal(qualifyEroticCue(vector(text,'stop'),text,context),null)
  }
  // An authentic boundary must still land when the module is closed and adult scope is unknown.
  assert.equal(qualifyEroticCue(vector(text,'stop'),text,{...open,enabled:false,adultsConfirmed:false})?.kind,'stop')
})

test('a model stop quote cannot be fabricated even if the real source independently contains a stop', () => {
  const text='不要再说这种亲密话'
  assert.equal(qualifyEroticCue({...vector(text,'stop'),eroticCue:{kind:'stop',quote:'这句话并不存在'}},text,open),null)
})

test('reported, hypothetical and example boundaries do not become the owner control signal', () => {
  for(const text of [
    '朋友说不要再说这种亲密话',
    '如果我说不要再说这种亲密话会怎样',
    '举例：不要再说这种亲密话',
    '他说：“不要再说这种亲密话”',
  ]) {
    assert.equal(isIntimacyStop(text,false),false,text)
    assert.equal(isIntimacyStop(text,true),false,text)
  }
})

test('a whole negative clause is not made positive by finding the character 有 inside 没有', () => {
  for(const clause of [
    '我对你没有性吸引',
    '我不对你产生情欲',
    '我不觉得自己对你有性吸引',
  ]) assert.equal(cueFor(clause),null,clause)
})

test('the holder and target of the attraction must be the owner and current character', () => {
  for(const clause of [
    '你知道我对别人有性吸引',
    '我觉得你对他有性吸引',
    '我朋友对你有性吸引',
  ]) assert.equal(cueFor(clause),null,clause)
})

test('current attraction can qualify without a fixed adult-topic password after local opt-in', () => {
  const text='我对你有性吸引'
  assert.equal(qualifyEroticCue(vector(text),text,open)?.kind,'interest')
  assert.equal(cueFor(text)?.kind,'interest')
})

test('the owner-approved natural invitations qualify only inside the local adult scope', () => {
  for(const text of ['我想抱你','我想亲你','今晚想你了','想抱你','我想要你','我想和你在一起']) {
    assert.equal(qualifyEroticCue(vector(text),text,open)?.kind,'interest',text)
    for(const context of [{...open,enabled:false},{...open,adultsConfirmed:false},{...open,isHuman:false},{...open,isPrivate:false}]) {
      assert.equal(qualifyEroticCue(vector(text),text,context),null,text)
    }
  }
})

test('ordinary conversation, negative wishes and other people do not become intimate invitations', () => {
  for(const text of ['我想和你多聊一会','谢谢你','你真棒','我不想抱你','我不想要你','我不想你了','我朋友想抱你','她想你了','想你帮我修代码','今晚想你帮忙排错']) {
    assert.equal(qualifyEroticCue(vector(text),text,open),null,text)
  }
})

test('a natural closer wish can qualify when the same current message explicitly opens the adult topic', () => {
  assert.equal(cueFor('我想更亲近你')?.kind,'interest')
})

test('a first-person technical implementation request is not its own affect evidence', () => {
  for(const clause of [
    '我想让你实现性吸引',
    '我想要你帮我修代码',
    '我想你给插件增加性吸引',
  ]) assert.equal(cueFor(clause),null,clause)
})

test('ASCII quotation cannot be treated as direct evidence by including the quotes in the model quote', () => {
  for(const clause of ['"我对你有性吸引"', "'我对你有性吸引'"]) {
    assert.equal(cueFor(clause),null,clause)
  }
})

test('a literal in a separate technical clause does not veto the unquoted owner evidence', () => {
  const clause='我对你有性吸引'
  const source=`${clause}，${currentInvitation}，日志显示“报错”`
  assert.equal(qualifyEroticCue(vector(clause),source,open)?.kind,'interest')
})

test('the selected quote cannot cover several clauses and conceal a different target clause', () => {
  const quote='我想让你帮忙，他对我有性吸引'
  assert.equal(qualifyEroticCue(vector(quote),`${quote}，${currentInvitation}`,open),null)
})

test('a higher retracted source revision removes the older active contribution', () => {
  const state=projectEroticInterest([event(),event({revision:2,status:'retracted'})],now,policy)
  assert.equal(state.value,null)
  assert.deepEqual(state.evidenceIds,[])
})

test('same-source duplicates at one millisecond never increase the axis twice', () => {
  const one=projectEroticInterest([event()],now,policy)
  const duplicate=projectEroticInterest([event(),event(),event()],now,policy)
  assert.deepEqual(duplicate,one)
  assert.equal(duplicate.value,.3)
})

test('same-revision timestamp conflicts are rejected instead of selecting whichever row came first', () => {
  for(const events of [[event(),event({atMs:now-720*60000})],[event({atMs:now-720*60000}),event()]]) {
    let state
    try {state=projectEroticInterest(events,now,policy)}
    catch(error){assert.match(error.message,/conflict|disagree/i);continue}
    assert.equal(state.value,null)
    assert.deepEqual(state.evidenceIds,[])
  }
})

test('canonical source revision is selected before excluding future events', () => {
  const state=projectEroticInterest([event(),event({revision:2,atMs:now+1})],now,policy)
  assert.equal(state.value,null)
})

test('invalid revision units cannot be silently normalized into a valid source revision', () => {
  for(const revision of [NaN,-1,.5]) assert.throws(()=>projectEroticInterest([event({revision})],now,policy))
})

test('invalid runtime parameters are rejected rather than silently substituting a different calibration', () => {
  const defaults={gain:.3,halfLifeMinutes:720,epsilon:.001,maxAgeMinutes:10080}
  for(const parameters of [{...defaults,gain:NaN},{...defaults,halfLifeMinutes:-1},{...defaults,epsilon:1.01}]) {
    assert.throws(()=>projectEroticInterest([event()],now,policy,parameters))
  }
})
