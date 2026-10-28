import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fixture } from '../helpers/fixture.mjs'
import { saveEmotionAppraisals, retractEmotionAppraisal, continuousAffect } from '../../lib/storage/continuous-affect.js'

const vector = { focus: 'action', agency: 'owner', desirability: .8, praiseworthiness: .8, quote: '谢谢你', confidence: .95 }
const objectVector = { focus: 'object', appealingness: .7, quote: '谢谢你', confidence: .9 }
const rowId = message => `emotion:${message.id}:0`

function source(f, id = 'withdrawal-source', content = '谢谢你记得我喜欢蓝色') {
  return f.repos.insertRawMessage({ id, conversationId: 'c', platformMessageKey: id, role: 'user', sourceKind: 'dsh',
    content, occurredAtMs: f.now(), observedAtMs: f.now(), deliveryStatus: null, deletedAtMs: null }).row
}

function state(f, id) { return f.db.get('SELECT status,revision,vector_json FROM emotion_appraisals WHERE id=?', id) }

test('explicit withdrawal survives repeated and delayed appraisals for the unchanged source', () => {
  const f = fixture()
  try {
    const message = source(f), id = rowId(message)
    saveEmotionAppraisals(f.repos, f.binding, message, [vector])
    assert.equal(retractEmotionAppraisal(f.repos, id, 'p'), 1)
    const before = state(f, id), revisions = f.db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, message, [vector]), 0)
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, message, [{ ...vector, desirability: .6 }]), 0)
    assert.deepEqual(state(f, id), before)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n, revisions)
    assert.equal(continuousAffect(f.repos, f.config, 'p', f.now()).appraisalCount, 0)
    const marker = JSON.parse(f.repos.getSetting(`emotion.retracted:${id}`))
    assert.deepEqual(marker, { version: 1, sourceMessageId: message.id,
      sourceHashes: [createHash('sha256').update(message.content).digest('hex')] })
    assert.ok(!JSON.stringify(marker).includes(message.content))
    assert.equal(retractEmotionAppraisal(f.repos, id, 'p'), 0)
  } finally { f.close() }
})

test('active observations still accept genuine revisions and preserve removed slots in revision history', () => {
  const f = fixture()
  try {
    const message = source(f), id = rowId(message)
    saveEmotionAppraisals(f.repos, f.binding, message, [vector, objectVector])
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, message, [{ ...vector, desirability: .6 }]), 1)
    assert.equal(state(f, id).status, 'active')
    assert.equal(state(f, id).revision, 2)
    assert.equal(JSON.parse(state(f, id).vector_json).desirability, .6)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n, 2)
    assert.equal(f.repos.getSetting(`emotion.retracted:${id}`), undefined)
    saveEmotionAppraisals(f.repos, f.binding, message, [vector, objectVector])
    assert.equal(f.db.get('SELECT status FROM emotion_appraisals WHERE slot=1').status, 'active', 'Ordinary slot replacement is not an explicit withdrawal')
  } finally { f.close() }
})

test('a source edited after withdrawal may be observed again while stale input and older withdrawn versions stay blocked', () => {
  const f = fixture()
  try {
    const original = source(f), id = rowId(original)
    saveEmotionAppraisals(f.repos, f.binding, original, [vector])
    retractEmotionAppraisal(f.repos, id, 'p')
    f.db.run('UPDATE raw_messages SET content=? WHERE id=?', '谢谢你今天又帮了我', original.id)
    assert.throws(() => saveEmotionAppraisals(f.repos, f.binding, original, [vector]), /source owner/u)
    const edited = f.repos.getRawMessage(original.id)
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, edited, [vector]), 1)
    assert.equal(state(f, id).status, 'active')
    retractEmotionAppraisal(f.repos, id, 'p')
    assert.equal(JSON.parse(f.repos.getSetting(`emotion.retracted:${id}`)).sourceHashes.length, 2)
    f.db.run('UPDATE raw_messages SET content=? WHERE id=?', original.content, original.id)
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, f.repos.getRawMessage(original.id), [vector]), 0)
    assert.equal(state(f, id).status, 'retracted')
  } finally { f.close() }
})

test('an automatically retracted appraisal can be recalculated from genuinely edited evidence', () => {
  const f = fixture()
  try {
    const message = source(f), id = rowId(message)
    saveEmotionAppraisals(f.repos, f.binding, message, [vector])
    f.db.run('UPDATE raw_messages SET content=? WHERE id=?', '谢谢你又记住了这个约定', message.id)
    assert.equal(state(f, id).status, 'retracted')
    assert.equal(f.repos.getSetting(`emotion.retracted:${id}`), undefined)
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, f.repos.getRawMessage(message.id), [vector]), 1)
    assert.equal(state(f, id).status, 'active')
  } finally { f.close() }
})

test('deleted, missing, wrong-owner and quote-invalid source evidence cannot reactivate an appraisal', () => {
  const f = fixture()
  try {
    const message = source(f), id = rowId(message)
    saveEmotionAppraisals(f.repos, f.binding, message, [vector])
    assert.equal(retractEmotionAppraisal(f.repos, id, 'other-owner'), 0)
    assert.equal(f.repos.getSetting(`emotion.retracted:${id}`), undefined)
    retractEmotionAppraisal(f.repos, id, 'p')
    assert.throws(() => saveEmotionAppraisals(f.repos, { ...f.binding, principalId: 'other-owner' }, message, [vector]), /source owner/u)
    assert.throws(() => saveEmotionAppraisals(f.repos, f.binding, message, [{ ...vector, quote: '不存在的证据' }]), /quote/u)
    f.db.run("UPDATE raw_messages SET deleted_at_ms=?,content='' WHERE id=?", f.now(), message.id)
    assert.throws(() => saveEmotionAppraisals(f.repos, f.binding, message, [vector]), /source owner/u)
    assert.throws(() => saveEmotionAppraisals(f.repos, f.binding, { ...message, id: 'missing' }, [vector]), /source owner/u)
    assert.equal(state(f, id), undefined)
    assert.equal(f.db.get('SELECT COUNT(*) AS n FROM emotion_appraisal_revisions').n, 0)
  } finally { f.close() }
})

test('a transferred withdrawal marker also prevents an already-active stale row from continuing to count', () => {
  const f = fixture()
  try {
    const message = source(f), id = rowId(message)
    saveEmotionAppraisals(f.repos, f.binding, message, [vector])
    f.repos.setSetting(`emotion.retracted:${id}`, JSON.stringify({ version: 1, sourceMessageId: message.id,
      sourceHashes: [createHash('sha256').update(message.content).digest('hex')] }), f.now())
    assert.equal(saveEmotionAppraisals(f.repos, f.binding, message, [vector]), 0)
    assert.equal(state(f, id).status, 'retracted')
    assert.equal(continuousAffect(f.repos, f.config, 'p', f.now()).appraisalCount, 0)
  } finally { f.close() }
})
