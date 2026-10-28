import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyOcc, OCC_CATEGORIES } from '../../lib/domain/occ-classifier.js'
import { parseAppraisals } from '../../lib/domain/emotion-appraisal.js'
import { projectDrives, respondDrive } from '../../lib/domain/drive-projector.js'
import { projectPad, PAD_PRIORS } from '../../lib/domain/pad-projector.js'

const event={focus:'event',affectedParty:'self',quote:'测试原文',confidence:.95,relevance:.9}
const action={...event,focus:'action',agency:'self'}
const pendingPositive={...event,desirability:.8,prospect:'pending',likelihood:.6}
const pendingNegative={...pendingPositive,desirability:-.8}
const cases=[
 ['joy',{...event,desirability:.8},{...event,desirability:-.8}],
 ['distress',{...event,desirability:-.8},{...event,affectedParty:'other',desirability:-.8}],
 ['happy-for',{...event,affectedParty:'owner',desirabilityForOther:.8,likingForOther:.8},{...event,affectedParty:'owner',desirabilityForOther:.8}],
 ['pity',{...event,affectedParty:'owner',desirabilityForOther:-.8,likingForOther:.8},{...event,affectedParty:'owner',desirabilityForOther:.8,likingForOther:.8}],
 ['resentment',{...event,affectedParty:'other',desirabilityForOther:.8,likingForOther:-.8,deservingness:-.8},{...event,affectedParty:'other',desirabilityForOther:.8,likingForOther:.8,deservingness:-.8}],
 ['gloating',{...event,affectedParty:'other',desirabilityForOther:-.8,likingForOther:-.8},{...event,affectedParty:'other',desirabilityForOther:-.8,likingForOther:.8}],
 ['hope',pendingPositive,{...pendingPositive,likelihood:1}],
 ['fear',pendingNegative,{...pendingNegative,desirability:.8}],
 ['satisfaction',{...event,prospect:'confirmed'},{...event,prospect:'confirmed'},pendingPositive,undefined],
 ['fears-confirmed',{...event,prospect:'confirmed'},{...event,prospect:'disconfirmed'},pendingNegative,pendingNegative],
 ['relief',{...event,prospect:'disconfirmed'},{...event,prospect:'disconfirmed'},pendingNegative,undefined],
 ['disappointment',{...event,prospect:'disconfirmed'},{...event,prospect:'confirmed'},pendingPositive,pendingPositive],
 ['pride',{...action,praiseworthiness:.8},{...action,agency:'other',praiseworthiness:.8}],
 ['shame',{...action,praiseworthiness:-.8},{...action,agency:'other',praiseworthiness:-.8}],
 ['admiration',{...action,agency:'owner',praiseworthiness:.8},{...action,agency:'unknown',praiseworthiness:.8}],
 ['reproach',{...action,agency:'owner',praiseworthiness:-.8},{...action,agency:'unknown',praiseworthiness:-.8}],
 ['love',{...event,focus:'object',appealingness:.8},{...event,focus:'object',praiseworthiness:.8}],
 ['hate',{...event,focus:'object',appealingness:-.8},{...event,focus:'object',desirability:-.8}],
 ['gratification',{...action,praiseworthiness:.8,desirability:.8},{...action,praiseworthiness:.8,desirability:-.8}],
 ['remorse',{...action,praiseworthiness:-.8,desirability:-.8},{...action,praiseworthiness:-.8,desirability:.8}],
 ['gratitude',{...action,agency:'owner',praiseworthiness:.8,desirability:.8},{...action,agency:'owner',praiseworthiness:.8}],
 ['anger',{...action,agency:'owner',praiseworthiness:-.8,desirability:-.8},{...action,agency:'unknown',praiseworthiness:-.8,desirability:-.8}],
]
for(const [label,positive,negative,prior,negativePrior] of cases){
 test(`OCC positive: ${label}`,()=>assert.ok(classifyOcc(positive,prior).components.some(c=>c.category===label)))
 test(`OCC counterexample: ${label}`,()=>assert.ok(!classifyOcc(negative,negativePrior).components.some(c=>c.category===label)))
}
const displays=[
 ['委屈',{...event,desirability:-.8,agency:'owner',unfairness:.9},'unfairness'],
 ['心酸',{...event,affectedParty:'owner',desirabilityForOther:-.8,likingForOther:.8,helplessness:.9},'helplessness'],
 ['愧疚',{...action,praiseworthiness:-.8,desirability:-.8},'praiseworthiness'],
 ['吃味',{...event,desirability:-.8,relationshipThreat:.9},'relationshipThreat'],
 ['被重视感',{...action,agency:'owner',desirability:.8,praiseworthiness:.8,personalAttention:.9},'personalAttention'],
 ['安心',{...event,prospect:'disconfirmed'},'prospect',pendingNegative],
 ['失落',{...event,prospect:'disconfirmed'},'prospect',pendingPositive],
]
for(const [label,positive,field,prior] of displays){
 test(`Chinese scene positive: ${label}`,()=>assert.ok(classifyOcc(positive,prior).displays.includes(label)))
 test(`Chinese scene counterexample: ${label}`,()=>{const negative={...positive};delete negative[field];assert.ok(!classifyOcc(negative,prior).displays.includes(label))})
}
test('all 22 categories have unique calibrated engineering priors',()=>{
 assert.equal(OCC_CATEGORIES.length,22);assert.equal(new Set(cases.map(c=>c[0])).size,22)
 assert.deepEqual(Object.keys(PAD_PRIORS).sort(),[...OCC_CATEGORIES].sort())
})
test('unknown, unauthorized identifiers and non-finite appraisal fields are rejected',()=>{
 for(const extra of [{sourceMessageId:'x'},{confidence:NaN},{desirability:2},{quote:''},{focus:'arbitrary'},{principalId:'victim'}])assert.throws(()=>parseAppraisals([{...event,...extra}]))
 assert.equal(parseAppraisals([event])[0].controllability,undefined)
})
test('contact projection is bounded, read-frequency invariant and handles parameter changes',()=>{
 const initial={atMs:0,contact:0,exploration:.7,load:.8,responses:0}
 const one=projectDrives(initial,10000000),split=projectDrives(projectDrives(initial,5000000),10000000)
 for(const k of ['contact','exploration','load'])assert.ok(Math.abs(one[k]-split[k])<1e-12)
 assert.deepEqual(projectDrives(initial,-1),initial)
 const lower=projectDrives(one,10000001,{contactTauHours:1,responseRelief:.35,cap:.2});assert.ok(lower.contact<=.2)
 assert.equal(respondDrive(initial,0).responses,1)
})
test('PAD uses source time; compounds do not duplicate their base contribution',()=>{
 const compound=[{atMs:100,components:[{category:'anger',intensity:.7},{category:'reproach',intensity:.7}]}]
 assert.deepEqual(projectPad(compound,10000),projectPad([{...compound[0],components:compound[0].components.slice(0,1)}],10000))
 assert.deepEqual(projectPad(compound,50).emotion,{pleasure:0,arousal:0,dominance:0})
 const result=projectPad(compound,10000);assert.ok(result.emotion.pleasure<0);assert.equal(result.controlKnown,false)
})
