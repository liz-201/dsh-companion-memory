import { createHash, randomUUID } from 'node:crypto'
import type { Repositories } from './repositories.js'
import type { IdentityBinding, RawMessage } from '../domain/types.js'
import { parseAppraisals } from '../domain/emotion-appraisal.js'
import { qualifyEroticCue, isIntimacyStop } from '../domain/erotic-evidence.js'
import { projectEroticInterest, type EroticInterestState } from '../domain/erotic-interest.js'
import { isHumanMessage, humanSourceSql } from '../memory/source-policy.js'
import { matchSourceQuote } from '../memory/quote-match.js'

const PREFIX = 'local.eroticPolicy:'
const EXPRESSION = 'local.intimacy-expression:'
const REVISION_BASE = 1000001
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
interface SavedPolicy {
  enabled: boolean
  ownerAdultConfirmed: boolean
  characterAdultConfirmed: boolean
  characterContextId: string
  acknowledgedStopIds: string[]
  resumeEpochMs: number
  revision: number
}
export interface LocalEroticPolicy extends SavedPolicy {
  adultsConfirmed: boolean
  stopped: boolean
  stopIds: string[]
}
export interface EroticPolicyInput {
  enabled: boolean
  ownerAdultConfirmed: boolean
  characterAdultConfirmed: boolean
  characterContextId?: string
  confirmedResume?: boolean
  knownStopIds?: string[]
}
const empty = (): SavedPolicy => ({ enabled:false,ownerAdultConfirmed:false,characterAdultConfirmed:false,characterContextId:'builtin',acknowledgedStopIds:[],resumeEpochMs:0,revision:0 })
function savedPolicy(repos: Repositories, principalId: string): SavedPolicy {
  const value=repos.getSetting(PREFIX+principalId)
  if(value===undefined)return empty()
  try {
    const p=JSON.parse(value) as SavedPolicy
    if(typeof p.enabled!=='boolean'||typeof p.ownerAdultConfirmed!=='boolean'||typeof p.characterAdultConfirmed!=='boolean'
      ||typeof p.characterContextId!=='string'||!p.characterContextId||p.characterContextId.length>500
      ||!Array.isArray(p.acknowledgedStopIds)||p.acknowledgedStopIds.some(id=>typeof id!=='string'||!id||id.length>1024)
      ||!timestamp(p.resumeEpochMs)||!Number.isSafeInteger(p.revision)||p.revision<0||p.revision>1000000000) return empty()
    return p
  } catch { return empty() }
}
/** Age declarations stay bound to the exact host-selected character identity. */
export function isEroticCharacterConfirmed(repos: Repositories, principalId: string, conversationId: string): boolean {
  const owner=repos.db.get<{principal_id:string;kind:string}>('SELECT principal_id,kind FROM conversations WHERE id=?',conversationId)
  if(owner?.principal_id!==principalId||owner.kind!=='private')return false
  const policy=readEroticPolicy(repos,principalId)
  return policy.adultsConfirmed&&(repos.getSetting(`local.session-persona:${conversationId}`)??'builtin')===policy.characterContextId
}
function assertOwner(repos: Repositories, principalId: string): void {
  if(!repos.db.get('SELECT id FROM principals WHERE id=?',principalId))throw Error('Unknown intimacy owner')
}
function stopIds(repos: Repositories, principalId: string): string[] {
  const rows=repos.db.all<{id:string}>('SELECT id FROM intimacy_stop_events WHERE principal_id=? ORDER BY id',principalId)
  if(rows.length>=REVISION_BASE)throw Error('Too many intimacy stop controls')
  return rows.map(row=>row.id)
}
/** Reads never manufacture a lease, permission, resume event or state increment. */
export function readEroticPolicy(repos: Repositories, principalId: string): LocalEroticPolicy {
  const saved=savedPolicy(repos,principalId), ids=stopIds(repos,principalId)
  const acknowledged=new Set(saved.acknowledgedStopIds)
  const stopped=ids.some(id=>!acknowledged.has(id))
  return {...saved,enabled:saved.enabled&&!stopped,adultsConfirmed:saved.ownerAdultConfirmed&&saved.characterAdultConfirmed,
    stopped,stopIds:ids,acknowledgedStopIds:[...saved.acknowledgedStopIds],revision:saved.revision*REVISION_BASE+ids.length}
}
/** Explicit, authenticated UI control only; imported packages never call this. */
export function setEroticPolicy(repos: Repositories, principalId: string, input: EroticPolicyInput, nowMs: number): LocalEroticPolicy {
  if(!input||typeof input!=='object'||Array.isArray(input)||!timestamp(nowMs)
    ||Object.keys(input).some(key=>!['enabled','ownerAdultConfirmed','characterAdultConfirmed','characterContextId','confirmedResume','knownStopIds'].includes(key))
    ||typeof input.enabled!=='boolean'||typeof input.ownerAdultConfirmed!=='boolean'||typeof input.characterAdultConfirmed!=='boolean'
    ||input.confirmedResume!==undefined&&typeof input.confirmedResume!=='boolean'
    ||input.characterContextId!==undefined&&(typeof input.characterContextId!=='string'||!input.characterContextId||input.characterContextId.length>500)
    ||input.knownStopIds!==undefined&&(!Array.isArray(input.knownStopIds)||input.knownStopIds.some(id=>typeof id!=='string'||!id||id.length>1024)))throw Error('Invalid intimacy policy')
  return repos.db.transaction(()=>{
    assertOwner(repos,principalId)
    const current=readEroticPolicy(repos,principalId), saved=savedPolicy(repos,principalId)
    if(input.enabled&&(!input.ownerAdultConfirmed||!input.characterAdultConfirmed))throw Error('Adult scope must be explicitly confirmed')
    if(input.enabled&&current.stopped){
      const known=[...new Set(input.knownStopIds??[])].sort()
      if(input.confirmedResume!==true||JSON.stringify(known)!==JSON.stringify(current.stopIds))throw Error('Confirm every current stop before resuming')
    }
    const contextId=input.characterContextId??'builtin'
    const next: SavedPolicy={enabled:input.enabled,ownerAdultConfirmed:input.ownerAdultConfirmed,characterAdultConfirmed:input.characterAdultConfirmed,characterContextId:contextId,
      acknowledgedStopIds:input.enabled&&current.stopped?[...current.stopIds]:[...saved.acknowledgedStopIds],
      resumeEpochMs:input.enabled&&(!current.enabled||current.stopped||contextId!==saved.characterContextId)?nowMs:saved.resumeEpochMs,revision:saved.revision}
    if(JSON.stringify({...next,revision:0})!==JSON.stringify({...saved,revision:0})){
      if(saved.revision>=1000000000)throw Error('Intimacy policy revision exhausted')
      next.revision++
      repos.setSetting(PREFIX+principalId,JSON.stringify(next),nowMs)
      repos.db.run('DELETE FROM plugin_settings WHERE key=?',EXPRESSION+principalId)
    }
    return readEroticPolicy(repos,principalId)
  })
}
/** Source IDs and source times make repeated observation on two devices identical. */
export function recordIntimacyStop(repos: Repositories, principalId: string, sourceMessageId: string|null, nowMs: number): LocalEroticPolicy {
  if(!timestamp(nowMs))throw Error('Invalid stop time')
  return repos.db.transaction(()=>{
    assertOwner(repos,principalId)
    const source=sourceMessageId===null?undefined:repos.getRawMessage(sourceMessageId)
    const owner=source&&repos.db.get<{principal_id:string;kind:string}>('SELECT principal_id,kind FROM conversations WHERE id=?',source.conversationId)
    if(sourceMessageId!==null&&(!source||!isHumanMessage(source)||owner?.principal_id!==principalId||owner.kind!=='private'))throw Error('Invalid intimacy stop source')
    const id=source?`intimacy-stop:${source.id}`:`intimacy-ui-stop:${randomUUID()}`
    // raw_messages has no physical originating-device field. This is an honest,
    // stable source marker; UI controls use the actual local device when known.
    const origin=source?`source:${createHash('sha256').update(source.id).digest('hex')}`:repos.getSetting('local.device-id')??'local-unregistered'
    const changed=repos.db.run('INSERT OR IGNORE INTO intimacy_stop_events(id,principal_id,source_message_id,created_at_ms,origin_device_id) VALUES(?,?,?,?,?)',id,principalId,source?.id??null,source?.occurredAtMs??nowMs,origin).changes
    if(changed){
      const saved=savedPolicy(repos,principalId)
      if(saved.revision>=1000000000)throw Error('Intimacy policy revision exhausted')
      repos.setSetting(PREFIX+principalId,JSON.stringify({...saved,enabled:false,revision:saved.revision+1}),nowMs)
      repos.db.run('DELETE FROM plugin_settings WHERE key=?',EXPRESSION+principalId)
    }
    return readEroticPolicy(repos,principalId)
  })
}
export function hasRecentIntimacyIntent(repos: Repositories, principalId: string, nowMs: number): boolean {
  const marker=readIntimacyExpression(repos,principalId)
  return !!marker&&marker.atMs<=nowMs&&nowMs-marker.atMs<=600000
}
export function readIntimacyExpression(repos: Repositories, principalId: string): {sourceId:string;atMs:number;policyRevision:number}|null {
  try{
    const marker=JSON.parse(repos.getSetting(EXPRESSION+principalId)??'null') as {sourceId:string;atMs:number;policyRevision:number}|null
    if(!marker||typeof marker.sourceId!=='string'||!marker.sourceId||!timestamp(marker.atMs)||marker.policyRevision!==readEroticPolicy(repos,principalId).revision)return null
    return marker
  }catch{return null}
}
export function recordIntimacyExpression(repos: Repositories, principalId: string, sourceId: string, nowMs: number): void {
  const policy=readEroticPolicy(repos,principalId), source=repos.getRawMessage(sourceId)
  if(!timestamp(nowMs)||!source||!isHumanMessage(source)||!policy.enabled||!policy.adultsConfirmed||policy.stopped||!isEroticCharacterConfirmed(repos,principalId,source.conversationId))return
  if(repos.db.get<{principal_id:string;kind:string}>('SELECT principal_id,kind FROM conversations WHERE id=?',source.conversationId)?.principal_id!==principalId)return
  repos.setSetting(EXPRESSION+principalId,JSON.stringify({sourceId,atMs:nowMs,policyRevision:policy.revision}),nowMs)
}
export function observeIntimacyStop(repos: Repositories, binding: IdentityBinding, message: RawMessage, nowMs: number, recent=hasRecentIntimacyIntent(repos,binding.principalId,nowMs)): boolean {
  const current=repos.getRawMessage(message.id)
  if(!current||!isHumanMessage(current)||current.content!==message.content||current.conversationId!==binding.conversationId)return false
  const owner=repos.db.get<{principal_id:string;kind:string}>('SELECT principal_id,kind FROM conversations WHERE id=?',current.conversationId)
  if(owner?.principal_id!==binding.principalId||owner.kind!=='private'||!isIntimacyStop(current.content,recent))return false
  recordIntimacyStop(repos,binding.principalId,current.id,nowMs)
  return true
}
/** Replays original evidence. Does not accept an imported local permission. */
export function eroticAffect(repos: Repositories, principalId: string, nowMs: number): EroticInterestState {
  const policy=readEroticPolicy(repos,principalId)
  const gate={enabled:policy.enabled,adultsConfirmed:policy.adultsConfirmed,stopped:policy.stopped,epochMs:policy.resumeEpochMs}
  if(!policy.enabled||!policy.adultsConfirmed||policy.stopped)return projectEroticInterest([],nowMs,gate)
  const rows=repos.db.all<{source_message_id:string;conversation_id:string;vector_json:string;revision:number;event_time_ms:number;content:string}>(`SELECT a.source_message_id,r.conversation_id,a.vector_json,a.revision,a.event_time_ms,r.content FROM emotion_appraisals a JOIN raw_messages r ON r.id=a.source_message_id JOIN conversations c ON c.id=r.conversation_id WHERE a.principal_id=? AND c.principal_id=? AND c.kind='private' AND a.conversation_id=r.conversation_id AND a.event_time_ms=r.occurred_at_ms AND a.status='active' AND ${humanSourceSql('r')} ORDER BY a.event_time_ms,r.id,a.slot`,principalId,principalId)
  const events=new Map<string,{sourceId:string;atMs:number;strength:number}>()
  for(const row of rows){
    const vector=parseAppraisals([JSON.parse(row.vector_json)])[0]!
    if(!vector.eroticCue||!matchSourceQuote(row.content,vector.quote))continue
    const cue=qualifyEroticCue(vector,row.content,{isHuman:true,isPrivate:true,enabled:policy.enabled,adultsConfirmed:isEroticCharacterConfirmed(repos,principalId,row.conversation_id)})
    if(cue?.kind!=='interest')continue
    const old=events.get(row.source_message_id)
    events.set(row.source_message_id,{sourceId:row.source_message_id,atMs:row.event_time_ms,strength:Math.max(old?.strength??0,cue.strength)})
  }
  return projectEroticInterest([...events.values()],nowMs,gate)
}
