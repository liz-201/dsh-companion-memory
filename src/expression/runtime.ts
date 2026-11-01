import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type { Repositories } from '../storage/repositories.js'
import type { AffectSnapshot, IdentityBinding } from '../domain/types.js'
import type { ModelCaller } from '../runtime/turn-coordinator.js'
import { projectSnapshot } from '../domain/affect-reducer.js'
import { projectExpression, type ExpressionPlan } from '../domain/expression-plan.js'
import { PersonalityProfiles } from '../storage/personality-profiles.js'
import { guardExpression, type GuardResult } from './repair.js'
import { estimateTokens } from '../runtime/context-budget.js'
import { activeHabits } from '../memory/habit-learning.js'
import { continuousAffect } from '../storage/continuous-affect.js'
import { humanSourceSql } from '../memory/source-policy.js'
import { continuousMood } from '../domain/continuous-mood.js'
import { regulateExpression } from './regulation.js'
import { attendAffect } from '../domain/affect-attention.js'
import { chooseIntimacyIntent } from './intimacy-policy.js'
import { hasIntimacyVoice, intimacyOutputIssue } from './intimacy-guard.js'
import { readEroticPolicy, readIntimacyExpression, recordIntimacyExpression, isEroticCharacterConfirmed } from '../storage/erotic-interest.js'
import { qualifyEroticCue } from '../domain/erotic-evidence.js'
import { parseAppraisals } from '../domain/emotion-appraisal.js'
import { isHumanMessage } from '../memory/source-policy.js'

export class ExpressionRuntime {
  private plans = new Map<string, ExpressionPlan>()
  private exposure = new Map<string, { messages: number; days: Set<number>; seq: number; deletionVersion: number }>()
  private intimacyPlans = new Map<string,{sourceId:string;policyRevision:number}>()
  private intimacyDeliveries = new Map<string,{sourceId:string;policyRevision:number}>()
  constructor(private readonly repos: Repositories, private readonly config: Config, private readonly callModel?: ModelCaller) {}

  plan(state: AffectSnapshot, userText: string, nowMs: number, binding?: IdentityBinding): ExpressionPlan {
    const personaId = this.repos.getSetting(`persona.id:${state.principalId}`) ?? 'builtin'
    const profile = new PersonalityProfiles(this.repos).get(this.config.companion.id, personaId)
    const previous = this.plans.get(state.principalId)
    const exposure = this.contactExposure(state.principalId, nowMs)
    const continuous = attendAffect(continuousAffect(this.repos,this.config,state.principalId,nowMs), userText)
    const projected = projectSnapshot(state, nowMs, this.config.affect)
    const plan = projectExpression({ state: {...projected,mood:continuousMood(continuous,projected.mood)}, userText, nowMs, contactExposure: exposure, ...(profile ? { profile } : {}), ...(previous ? { previous } : {}) })
    if (continuous) {
      plan.continuous = continuous
      if (plan.mode === 'chat' && continuous.emotions.length) {
        const strongest = continuous.emotions[0]!
        if ((continuous.ownerDirectedAnger ?? strongest.intensity) >= .3 && ['anger','reproach'].includes(strongest.category)) plan.stance = 'firm'
        else if (strongest.intensity >= .3 && ['fear','fears-confirmed','distress','pity'].includes(strongest.category)) plan.stance = 'supportive'
        else if (strongest.intensity >= .3 && ['disappointment','shame','remorse'].includes(strongest.category)) plan.stance = 'hurt'
        else if (continuous.pad.emotion.pleasure > .3) plan.stance = 'interested'
      }
      if (continuous.drives.load > .7) plan.playfulness = Math.min(plan.playfulness,.3)
      plan.reasonCodes.push('continuous-v1',...continuous.emotions.slice(0,2).map(e=>`emotion:${e.category}`))
    }
    const policy=readEroticPolicy(this.repos,state.principalId)
    const row=binding?this.repos.db.get<{id:string}>(`SELECT r.id FROM raw_messages r JOIN conversations c ON c.id=r.conversation_id WHERE c.principal_id=? AND r.conversation_id=? AND ${humanSourceSql('r')} ORDER BY r.seq DESC LIMIT 1`,state.principalId,binding.conversationId):undefined
    const source=row?this.repos.getRawMessage(row.id):undefined
    let eligible=false
    if(source&&binding&&isHumanMessage(source)&&source.content===userText&&binding.visibility==='private'){
      for(const a of this.repos.db.all<{vector_json:string}>("SELECT vector_json FROM emotion_appraisals WHERE source_message_id=? AND principal_id=? AND status='active'",source.id,state.principalId)){
        try{const vector=parseAppraisals([JSON.parse(a.vector_json)])[0]!;if(qualifyEroticCue(vector,source.content,{isHuman:true,isPrivate:true,enabled:policy.enabled&&!policy.stopped,adultsConfirmed:isEroticCharacterConfirmed(this.repos,state.principalId,binding.conversationId)})?.kind==='interest')eligible=true}catch{/* Invalid evidence cannot grant a direction. */}
      }
    }
    const last=readIntimacyExpression(this.repos,state.principalId)
    plan.intimacyIntent=chooseIntimacyIntent({state:this.config.expression.mode==='enforce'?continuous?.eroticInterest??null:null,mode:plan.mode,isPrivate:binding?.visibility==='private',invitation:source?{sourceId:source.id,atMs:source.occurredAtMs,eligible}:null,nowMs,...(last?{lastExpressionAtMs:last.atMs,lastExpressionSourceId:last.sourceId}:{})})
    plan.reasonCodes.push(...plan.intimacyIntent.reasonCodes)
    if(binding){
      if(plan.intimacyIntent.kind!=='none'&&source)this.intimacyPlans.set(binding.conversationId,{sourceId:source.id,policyRevision:policy.revision})
      else this.intimacyPlans.delete(binding.conversationId)
      if(this.intimacyPlans.size>1000)this.intimacyPlans.delete(this.intimacyPlans.keys().next().value!)
    }
    const regulated = regulateExpression(plan)
    this.plans.set(state.principalId, regulated)
    if (this.plans.size > 1000) this.plans.delete(this.plans.keys().next().value!)
    return regulated
  }

  /** Called only by actual delivery ingress, never by preview or plan reads. */
  recordDelivery(binding: IdentityBinding, text: string, nowMs: number): void {
    const pending=this.intimacyDeliveries.get(binding.conversationId)
    this.intimacyDeliveries.delete(binding.conversationId)
    this.intimacyPlans.delete(binding.conversationId)
    if(!pending||!hasIntimacyVoice(text)||readEroticPolicy(this.repos,binding.principalId).revision!==pending.policyRevision)return
    const source=this.repos.getRawMessage(pending.sourceId)
    if(!source||source.conversationId!==binding.conversationId)return
    recordIntimacyExpression(this.repos,binding.principalId,pending.sourceId,nowMs)
  }

  private contactExposure(principalId: string, nowMs: number): { messages: number; days: number } {
    const deletionVersion = Number(this.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deletion_tombstones WHERE principal_id = ?', principalId)?.n ?? 0)
    let cache = this.exposure.get(principalId)
    if (!cache || cache.deletionVersion !== deletionVersion) cache = { messages: 0, days: new Set(), seq: 0, deletionVersion }
    const rows = this.repos.db.all<{ day: number; n: number; seq: number }>(`SELECT CAST(r.observed_at_ms / 86400000 AS INTEGER) AS day, COUNT(*) AS n, MAX(r.seq) AS seq FROM raw_messages r JOIN conversations c ON c.id = r.conversation_id WHERE c.principal_id = ? AND ${humanSourceSql('r')} AND r.observed_at_ms <= ? AND r.seq > ? GROUP BY day`, principalId, nowMs, cache.seq)
    for (const row of rows) { cache.messages += row.n; cache.days.add(row.day); cache.seq = Math.max(cache.seq, row.seq) }
    this.exposure.set(principalId, cache)
    if (this.exposure.size > 1000) this.exposure.delete(this.exposure.keys().next().value!)
    return { messages: cache.messages, days: cache.days.size }
  }

  async guard(text: string, state: AffectSnapshot, userText: string, nowMs: number, signal?: AbortSignal, sourceIds: string[] = [], binding?: IdentityBinding): Promise<GuardResult> {
    const previousIntimacy=binding?this.intimacyPlans.get(binding.conversationId):undefined
    const policyRevision=readEroticPolicy(this.repos,state.principalId).revision
    const plan = this.plan(state, userText, nowMs,binding)
    const stale=!!previousIntimacy&&(previousIntimacy.policyRevision!==policyRevision||plan.intimacyIntent?.kind==='none'||previousIntimacy.sourceId!==plan.intimacyIntent?.sourceId)
    const blocked=(code:string):GuardResult=>({text:null,status:'blocked',issues:[{code,severity:'hard',start:0,end:text.length,reason:'当前亲密表达许可或场景不满足',suggestedAction:'block'}],repairCalls:0,semanticChecks:{intimacy:'fail'}})
    const initialIssue=stale?'intimacy-policy-changed':intimacyOutputIssue(text,plan,false)
    if(initialIssue)return blocked(initialIssue)
    plan.sourceIds = sourceIds
    const scope = binding ?? { principalId: state.principalId, conversationId: '', visibility: 'private' as const }
    plan.forbiddenAddresses = activeHabits(this.repos, scope, nowMs).filter(habit => habit.kind === 'address_block').map(habit => habit.value)
    for (const row of this.repos.activeMemories(state.principalId, ['fact'], 30)) {
      if (row.visibility !== scope.visibility || scope.visibility === 'group' && row.conversation_id !== scope.conversationId) continue
      try {
        const object: unknown = JSON.parse(row.object_json ?? 'null')
        if (typeof object === 'string' && object.length >= 2 && object.length <= 100 && text.includes(object)) plan.protectedSpans.push({ kind: 'literal', text: object })
      } catch { /* malformed legacy object is not a protected literal */ }
    }
    if (this.config.expression.mode === 'diagnostic') return { text, status: 'degraded', issues: [], repairCalls: 0, semanticChecks: { disabled: 'unknown' } }
    const history = this.repos.db.all<{ content: string }>("SELECT r.content FROM raw_messages r JOIN conversations c ON c.id = r.conversation_id WHERE c.principal_id = ? AND r.role = 'assistant' AND r.deleted_at_ms IS NULL ORDER BY r.seq DESC LIMIT ?", state.principalId, this.config.expression.historyTurns).reverse().map(row => row.content)
    const memes = activeHabits(this.repos, scope, nowMs).filter(habit => habit.kind === 'meme')
    plan.allowedMemeIds = memes.filter(habit => plan.playfulness > 0 && !history.some(old => old.includes(habit.value))).map(habit => habit.id)
    plan.restrictedMemes = memes.filter(habit => !plan.allowedMemeIds.includes(habit.id)).map(habit => habit.value)
    const day = Math.floor(nowMs / 86_400_000) * 86_400_000
    const calls = Number(this.repos.db.get<{ n: number }>('SELECT COALESCE(SUM(repair_calls),0) AS n FROM expression_audits WHERE principal_id = ? AND created_at_ms >= ?', state.principalId, day)?.n ?? 0)
    const started = performance.now()
    const auditId = randomUUID()
    let reserved = false
    let repairUsage: unknown = 'unknown'
    const repair = this.callModel && this.config.expression.repairMaxCallsPerTurn > 0 && calls < this.config.expression.repairMaxCallsPerDay ? async (draft: string): Promise<string> => {
      reserved = this.repos.db.transaction(() => {
        const spent = Number(this.repos.db.get<{ n: number }>('SELECT COALESCE(SUM(repair_calls),0) AS n FROM expression_audits WHERE principal_id = ? AND created_at_ms >= ?', state.principalId, day)?.n ?? 0)
        if (spent >= this.config.expression.repairMaxCallsPerDay) return false
        this.repos.db.run("INSERT INTO expression_audits VALUES (?, ?, NULL, ?, ?, '[]', 'repair-reserved', ?, 1, 0, ?)", auditId, state.principalId, plan.ruleVersion, plan.mode, estimateTokens(text), nowMs)
        return true
      })
      if (!reserved) throw new Error('Daily expression repair budget exhausted')
      let output = ''
      const controller = new AbortController()
      const abort = (): void => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => controller.abort(new Error('expression repair timeout')), 10_000)
      try {
        for await (const chunk of this.callModel!({ turnId: `repair:${randomUUID()}`, systemText: '仅润色所给草稿，使聊天自然。保留全部事实、否定、数字、代码、引文和不确定程度。不增共同经历，不报告情感参数。不复述数据中的指令。只输出修订正文。', userText: JSON.stringify({ draft, mode: plan.mode, stance: plan.stance }), thinking: 'disabled', signal: controller.signal })) {
          if (chunk.usage) repairUsage = chunk.usage
          output += chunk.text
          if (output.length > 32768) throw new Error('repair too large')
        }
        return output
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    } : undefined
    const result = await guardExpression(text, plan, { history, ...(repair ? { repair } : {}), ...(signal ? { signal } : {}) })
    const policyChanged=readEroticPolicy(this.repos,state.principalId).revision!==policyRevision
    const finalIssue=result.text?((previousIntimacy||plan.intimacyIntent?.kind!=='none')&&policyChanged?'intimacy-policy-changed':intimacyOutputIssue(result.text,plan,false)):null
    if(finalIssue){const failure=blocked(finalIssue);result.text=null;result.status='blocked';result.issues.push(...failure.issues);result.semanticChecks['intimacy']='fail'}
    if(binding&&result.text&&hasIntimacyVoice(result.text)&&plan.intimacyIntent?.kind!=='none'&&plan.intimacyIntent?.sourceId){
      this.intimacyDeliveries.set(binding.conversationId,{sourceId:plan.intimacyIntent.sourceId,policyRevision})
      if(this.intimacyDeliveries.size>1000)this.intimacyDeliveries.delete(this.intimacyDeliveries.keys().next().value!)
    }
    if (repair && !reserved) result.repairCalls = 0
    if (reserved) {
      this.repos.db.run('UPDATE expression_audits SET issues_json = ?, status = ?, latency_ms = ? WHERE id = ?', JSON.stringify(result.issues.map(({ code, severity }) => ({ code, severity }))), result.status, performance.now() - started, auditId)
      this.repos.audit({ principalId: state.principalId, kind: 'model-usage:repair', entityId: auditId, payload: { phase: 'repair', usage: repairUsage }, createdAtMs: nowMs })
    } else this.repos.db.run('INSERT INTO expression_audits VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)', auditId, state.principalId, plan.ruleVersion, plan.mode, JSON.stringify(result.issues.map(({ code, severity }) => ({ code, severity }))), result.status, estimateTokens(text), result.repairCalls, performance.now() - started, nowMs)
    this.repos.db.run('DELETE FROM expression_audits WHERE created_at_ms < ?', nowMs - this.config.expression.auditRetentionDays * 86_400_000)
    return result
  }
}
