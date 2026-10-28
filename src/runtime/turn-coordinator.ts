/**
 * 回合编排（任务书 §6.1–6.7、6.3–6.5、6.8、12.2、14.4）。
 *
 * 前台时间线（§6.2）在这里落成一条直线，每一步都是可重放的显式输入：
 *
 *   入站落库（幂等）
 *     。同会话串行排队（§6.1。
 *     。装配：读状态投。+ 检索记。+ 检查点 。预算测量（。2。
 *     。调模型（流式。
 *     。<say> 关闭 。发送（early send 或交给桥的最终发送）
 *     。<evt> 校验 。应用（评。。情感 。episode 。记忆候。。提醒任务。
 *     。后台巩固入队（前台不等，§17.4。
 *
 * 硬约束：
 *   · 模型看不。evt（。.4）——历史条目只留正文；
 *   · 来源绑定在服务端完成，模型给不了 sourceMessageId（。7.2）；
 *   · 尾部失败不回滚已发出的正文，只记。tail_status（。.3）；
 *   · 任何一步抛错都转成 TurnOutcome.failed，不把异常抛。QQ 桥。
 */

import type { Config } from '../config.js'
import { decideStrategy, checkContinuity } from '../domain/interaction-policy.js'
import { checkEligibility, isRepairIntent } from '../domain/event-policy.js'
import { initialSnapshot, projectSnapshot, reduce } from '../domain/affect-reducer.js'
import { personalityPreset } from '../domain/personality.js'
import { dailyUsage, rebuildAffect } from '../domain/affect-projector.js'
import { saveEmotionAppraisals, priorExpectations, priorBehaviors, continuousAffect } from '../storage/continuous-affect.js'
import { continuousMood, retrievalArousal } from '../domain/continuous-mood.js'
import { EMOTION_CONTRACT, parseObservation } from './emotion-observation.js'
import { perceptionContext } from './perception-context.js'
import type { EmotionAppraisal } from '../domain/emotion-appraisal.js'
import { emptyDelta, transition, worthMentioning } from '../domain/episode-manager.js'
import { looksLikeReminderRequest, parseWhen } from '../domain/time-parse.js'
import { systemClock, type Clock, type DeliveryReceipt, type EpisodeRecord, type IdentityBinding, type RawMessage, type RelationshipDelta, type ValidatedAppraisal } from '../domain/types.js'
import type { Repositories } from '../storage/repositories.js'
import type { Retriever } from '../memory/retriever.js'
import type { FactUpdater } from '../memory/fact-updater.js'
import { buildContext, renderBoundaries, renderCheckpoint, describeBudget, PromptStore } from './context-builder.js'
import { TokenLedger, estimatedCounter, type TokenCounter } from './context-budget.js'
import { StreamParser, type ParserResult } from './stream-parser.js'
import { LIMITS, parseEvt, renderReply, type EvtPayload } from './output-protocol.js'
import type { ConversationQueue } from './conversation-queue.js'
import { Metrics } from './metrics.js'
import type { BackgroundQueue } from './background-queue.js'
import { EVENT_KINDS, MEMORY_HINTS } from './output-protocol.js'
import { hashKey } from '../memory/consolidator.js'
import { matchSourceQuote } from '../memory/quote-match.js'
import { reuseOwnerMemoryId } from '../memory/identity-memory.js'
import { scheduleConsolidation } from './consolidation-scheduler.js'
import { renderInteractionHabits } from '../memory/interaction-habits.js'
import { ExpressionRuntime } from '../expression/runtime.js'
import { CORE_POLICY, renderPlan } from '../expression/policy.js'
import { annotateEpisode } from '../memory/episodic.js'
import { learnExplicitHabit } from '../memory/habit-learning.js'
import { observeOpportunity } from '../proactive/opportunity.js'
import { observeFeedback } from '../proactive/feedback.js'
import { isHumanMessage } from '../memory/source-policy.js'
import { currentStrategyAppraisal, observationStrategyAppraisals } from './strategy-appraisal.js'

export interface ModelCallRequest {
  images?: {data:string;mediaType:'image/png'}[]
  turnId: string
  /** 已装配好的完整输入（人格 + 状。+ 记忆 + 正文）。*/
  systemText: string
  userText: string
  thinking: 'disabled' | 'default'
  signal?: AbortSignal
}

export interface ModelChunk {
  text: string
  /** provider 上报的用量；没有就留 undefined，绝不填 0。*/
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheHitTokens?: number
    cacheMissTokens?: number
    reasoningTokens?: number
    provider?: string
    model?: string
  }
}

/** 宿主模型调用的窄接口：返回异步分片流。模型名由宿主配置决定，不硬编码。*/
export type ModelCaller = (request: ModelCallRequest) => AsyncIterable<ModelChunk>

export interface SendRequest {
  conversationId: string
  turnId: string
  text: string
  /** 发送前要复核的入站序号（。4.4）。*/
  expectedInboundSeq: number
}

export type TurnSender = (request: SendRequest) => Promise<DeliveryReceipt>

export interface InboundTurn {
  binding: IdentityBinding
  /** 平台会话 id（`private:123` / `group:456`），用于发回同一条通道。*/
  chatId: string
  text: string
  platformMessageKey: string | null
  occurredAtMs: number
  observedAtMs: number
  sourceKind?: string
  /** 宿主 session id；用于检查点与会话映射。*/
  sessionId: string
  /** 外部已分。turnId 时用它做幂等键。*/
  turnId?: string
  send?: TurnSender
  review?: boolean
}

export type TurnStatus = 'completed' | 'say-only' | 'failed' | 'queued-full' | 'skipped'

export interface TurnOutcome {
  turnId: string
  status: TurnStatus
  say: string | null
  /** evt 是否成功应用；false 表示尾部缺失/非法但正文已发出。*/
  evtApplied: boolean
  sent: DeliveryReceipt | null
  injectedMemoryIds: string[]
  budget: string
  problems: string[]
  error?: string
  durationMs: number
}

export interface TurnCoordinatorDeps {
  beforeContext?:(query:string,binding:IdentityBinding)=>Promise<void>
  config: Config
  repos: Repositories
  retriever: Retriever
  updater: FactUpdater
  queue: ConversationQueue
  metrics: Metrics
  ledger: TokenLedger
  prompts: PromptStore
  background?: BackgroundQueue | undefined
  send: TurnSender
  callModel: ModelCaller
  clock?: Clock
  counter?: TokenCounter
  deviceText?: string
  /** 会话是否处于「已建立的互损语境」——由调用方根据近期事件给出。*/
  teasingContext?: (conversationId: string) => boolean
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

let turnCounter = 0

function nextTurnId(nowMs: number): string {
  turnCounter = (turnCounter + 1) % 1_000_000
  return `t${nowMs.toString(36)}-${turnCounter.toString(36)}`
}

export class TurnCoordinator {
  private readonly clock: Clock
  private readonly counter: TokenCounter
  private readonly expression: ExpressionRuntime
  private readonly observations = new Map<string,Promise<void>>()
  private readonly strategyObservations = new Map<string, { signature: string; appraisals: ValidatedAppraisal[] }>()

  get activeObservations(): number { return this.observations.size }

  constructor(private readonly deps: TurnCoordinatorDeps) {
    this.clock = deps.clock ?? systemClock
    this.counter = deps.counter ?? estimatedCounter
    this.expression = new ExpressionRuntime(deps.repos, deps.config, deps.callModel)
  }

  recordObservationUsage(turnId: string, attempt: number, usage: ModelChunk['usage']): void {
    const entry = { turnId, phase: turnId.startsWith('before-reply:')?'evaluation' as const:'background' as const, provider: usage?.provider ?? 'host', model: usage?.model ?? 'host-default',
      inputTokens: usage?.inputTokens ?? 'unknown' as const, outputTokens: usage?.outputTokens ?? 'unknown' as const,
      cacheHitTokens: usage?.cacheHitTokens ?? 'unknown' as const, cacheMissTokens: usage?.cacheMissTokens ?? 'unknown' as const,
      reasoningTokens: usage?.reasoningTokens ?? 'unknown' as const, retry: attempt - 1, atMs: this.clock.now() }
    this.deps.ledger.record(entry)
    if (this.deps.repos.db.isOpen) this.deps.repos.audit({ principalId: null, kind: 'model-usage', entityId: turnId, payload: entry, createdAtMs: entry.atMs })
  }

  /** One bounded extraction shared by pre-reply evaluation and the durable retry queue. */
  requestObservation(binding:IdentityBinding,message:RawMessage,id=`observation:${message.id}`,attempt=1,previousError?:string,options:{callModel?:ModelCaller;active?:()=>boolean}={}):Promise<void> {
    if (!isHumanMessage(message)) return Promise.resolve()
    const deps=this.deps,key=`emotion.observed:${message.id}`,signature=hashKey(message.content)
    if(deps.repos.getSetting(key)===signature)return Promise.resolve()
    const existing=this.observations.get(message.id)
    if(existing)return existing
    const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>,usage:ModelChunk['usage']
    const execute=async():Promise<void>=>{
      let output=''
      const systemText=deps.prompts.protocol()+'\n'+EMOTION_CONTRACT
      const input={outputContract:'<observation>{"v":2,"legacy":{"v":1,"e":[]},"appraisals":[]}</observation>',userMessage:message.content.slice(0,8000),priorExpectations:priorExpectations(deps.repos,binding.principalId,message.occurredAtMs),priorBehaviors:priorBehaviors(deps.repos,binding.principalId,message),...(previousError?{correction:previousError.slice(0,700)}:{})}
      while(input.userMessage.length>100&&this.counter.count(systemText)+this.counter.count(JSON.stringify(input))+16>deps.config.memory.inputHardLimitTokens)input.userMessage=input.userMessage.slice(0,Math.floor(input.userMessage.length*.8))
      while(this.counter.count(systemText)+this.counter.count(JSON.stringify(input))+16>deps.config.memory.inputHardLimitTokens&&(input.priorBehaviors.length||input.priorExpectations.length)){
        if(input.priorBehaviors.length)input.priorBehaviors.pop();else input.priorExpectations.pop()
      }
      const userText=JSON.stringify(input)
      if(this.counter.count(systemText)+this.counter.count(userText)+16>deps.config.memory.inputHardLimitTokens)throw Error('Observation input budget exceeded')
      for await(const chunk of (options.callModel??deps.callModel)({turnId:id,thinking:'disabled',signal:controller.signal,systemText,userText})){
        if(controller.signal.aborted)throw Error('Observation timed out')
        output+=chunk.text;if(chunk.usage)usage=chunk.usage
        if(output.length>16000)throw Error('Observation output too large')
      }
      const current=deps.repos.db.isOpen?deps.repos.getRawMessage(message.id):null
      if(controller.signal.aborted||options.active?.()===false||!current||current.deletedAtMs!==null||current.content!==message.content)return
      const parsed=parseObservation(output)
      await this.observe(binding,current,parsed.legacy,{...(parsed.appraisals?{appraisals:parsed.appraisals}:{}),skipLegacy:message.sourceKind==='qq'})
      if(!controller.signal.aborted) {
        this.strategyObservations.set(message.id, { signature, appraisals: observationStrategyAppraisals(parsed.legacy, current) })
        if (this.strategyObservations.size > 1000) this.strategyObservations.delete(this.strategyObservations.keys().next().value!)
        deps.repos.setSetting(key,signature,this.clock.now())
      }
    }
    const timeoutMs=id.startsWith('before-reply:')?deps.config.emotion.timeoutMs:deps.config.emotion.backgroundTimeoutMs
    const promise=Promise.race([execute(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Observation timed out'))},timeoutMs)})])
      .finally(()=>{clearTimeout(timer);this.observations.delete(message.id);this.recordObservationUsage(id,attempt,usage)})
    this.observations.set(message.id,promise)
    return promise
  }

  async observeBeforeReply(binding:IdentityBinding,message:RawMessage):Promise<void>{
    if(!this.deps.config.emotion.enabled||this.deps.config.emotion.mode!=='before-reply')return
    let timer:ReturnType<typeof setTimeout>
    try{await Promise.race([this.requestObservation(binding,message,`before-reply:${message.id}`),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Pre-evaluation wait expired')),this.deps.config.emotion.timeoutMs)})])}catch{
      this.deps.metrics.count('emotion.before-reply-pending',1)
    }finally{clearTimeout(timer!)}
  }

  /** Apply background observations to a persisted host message without generating a second reply. */
  async observe(binding: IdentityBinding, message: RawMessage, payload: EvtPayload,
    options: { producer?: 'background_observer' | 'local_rule'; appraisals?: EmotionAppraisal[]; skipLegacy?: boolean } = {}): Promise<void> {
    if (!isHumanMessage(message) || this.deps.repos.getRawMessage(message.id)?.deletedAtMs !== null || this.deps.repos.getRawMessage(message.id)?.content!==message.content) return
    const now = this.clock.now()
    const turnId = `observe:${message.id}`
    const previousTurn = this.deps.repos.getTurn(turnId)
    if (options.appraisals !== undefined) saveEmotionAppraisals(this.deps.repos,binding,message,options.appraisals)
    if (previousTurn?.status === 'completed') return
    if (options.producer !== 'local_rule' && this.deps.repos.db.get("SELECT id FROM appraisals WHERE source_message_id=? AND producer='local_rule' LIMIT 1",message.id)) {
      this.deps.repos.db.transaction(() => {
        const retracted = this.deps.repos.db.run("UPDATE affect_events SET status='retracted' WHERE principal_id=? AND status='active' AND appraisal_id IN (SELECT id FROM appraisals WHERE source_message_id=? AND producer='local_rule')",binding.principalId,message.id).changes
        this.deps.repos.db.run("UPDATE appraisals SET status='retracted' WHERE source_message_id=? AND producer='local_rule'",message.id)
        if (retracted) { const current=this.deps.repos.getSnapshot(binding.principalId);this.deps.repos.putSnapshot(rebuildAffect(this.deps.repos,this.deps.config,binding.principalId,now),current?.revision??0) }
      })
    }
    if (!previousTurn) this.deps.repos.createTurn({ id: turnId, conversation_id: message.conversationId,
      session_id: binding.conversationId, inbound_message_id: message.id, state_revision_used: null,
      status: 'running', started_at_ms: now })
    const stored = this.deps.repos.getSnapshot(binding.principalId)
    const snapshot = stored?.snapshot ?? initialSnapshot(binding.principalId, this.deps.config.companion.preset, this.deps.config.affect.ruleVersion, now)
    const problems: string[] = []
    await this.applyEvt(turnId, binding, {
      binding, chatId: '', text: message.content, platformMessageKey: message.platformMessageKey,
      occurredAtMs: message.occurredAtMs, observedAtMs: now, sessionId: binding.conversationId,
    }, message, { ...payload, e: options.skipLegacy ? [] : payload.e, t: [] }, snapshot, problems,
      options.producer ?? 'background_observer')
    if (problems.some(problem => /^(evt-apply-failed|memory-write-failed)/.test(problem))) {
      this.deps.repos.updateTurn(turnId, { status: 'failed', tail_status: 'rejected', ended_at_ms: now })
      throw new Error(problems.join('; '))
    }
    const current = this.deps.repos.getSnapshot(binding.principalId)
    const projected = projectSnapshot(current?.snapshot ?? snapshot, now, this.deps.config.affect)
    this.deps.repos.putSnapshot({ ...projected, projectedThroughSeq: Math.max(projected.projectedThroughSeq, message.seq) }, current?.revision ?? 0)
    this.deps.repos.updateTurn(turnId, { status: options.producer === 'local_rule' ? 'fallback' : 'completed',
      tail_status: options.producer === 'local_rule' ? 'fallback' : 'applied', ended_at_ms: now })
  }

  /**
   * 处理一条入站消息。返回的结果只用来看日志/测试，调用方不依赖它做业务流程。
   *
   * 幂等：同一 (conversation, platformMessageKey, role=user) 重复到达时，
   * insertRawMessage 返回 inserted=false，这里直。skipped，不会再开一轮模型。
   */
  async handleInbound(inbound: InboundTurn): Promise<TurnOutcome> {
    const startedAt = this.clock.now()
    const turnId = inbound.turnId ?? nextTurnId(startedAt)
    const binding = inbound.binding
    const conversationId = binding.conversationId
    const problems: string[] = []

    const base: TurnOutcome = {
      turnId,
      status: 'skipped',
      say: null,
      evtApplied: false,
      sent: null,
      injectedMemoryIds: [],
      budget: '',
      problems,
      durationMs: 0,
    }

    // 1) 入站落库（先落库再排队：断线重连时靠它去重）
    let message: RawMessage
    try {
      const inserted = this.deps.repos.insertRawMessage({
        id: `${conversationId}:${inbound.platformMessageKey ?? `${turnId}`}`,
        conversationId,
        platformMessageKey: inbound.platformMessageKey,
        role: 'user',
        sourceKind: inbound.sourceKind ?? 'qq',
        content: inbound.text,
        occurredAtMs: inbound.occurredAtMs,
        observedAtMs: inbound.observedAtMs,
        deliveryStatus: null,
        deletedAtMs: null,
      })
      message = inserted.row
      if (!inserted.inserted) {
        return { ...base, status: 'skipped', problems: ['duplicate-inbound'], durationMs: this.clock.now() - startedAt }
      }
      if (!isHumanMessage(message)) return { ...base, status: 'skipped', problems: ['non-human-source'], durationMs: this.clock.now() - startedAt }
      if(message.sourceKind==='qq'&&binding.visibility==='private')this.deps.background?.enqueue('extract',{messageId:message.id},{dedupKey:`observe:${message.id}`,principalId:binding.principalId,availableAtMs:startedAt+1000,nowMs:startedAt})
    } catch (error) {
      return { ...base, status: 'failed', error: describeError(error), durationMs: this.clock.now() - startedAt }
    }

    // 2) 同会话串行（不同会话互不阻塞。
    const result = await this.deps.queue.run({
      conversationId,
      turnId,
      run: async () => {
        const outcome = await this.runTurn(turnId, inbound, message)
        Object.assign(base, outcome)
      },
    })
    if (!result.queued) {
      return {
        ...base,
        status: result.reason === 'full' ? 'queued-full' : 'failed',
        error: result.reason,
        durationMs: this.clock.now() - startedAt,
      }
    }
    base.durationMs = this.clock.now() - startedAt
    return base
  }

  private async runTurn(turnId: string, inbound: InboundTurn, message: RawMessage): Promise<TurnOutcome> {
    const deps = this.deps
    const now = this.clock.now()
    const binding = inbound.binding
    await this.observeBeforeReply(binding,message)
    await deps.beforeContext?.(message.content,binding)
    learnExplicitHabit(deps.repos, binding, message)
    observeFeedback(deps.repos, binding, message)
    observeOpportunity(deps.repos, binding, message)
    const conversationId = binding.conversationId
    const problems: string[] = []
    let say: string | null = null
    let sent: DeliveryReceipt | null = null
    let evtApplied = false
    let budget = ''
    let injectedMemoryIds: string[] = []
    let modelStarted = false
    const usage: ModelChunk['usage'][] = []
    const receiptKind = (): string => sent?.kind ?? 'missing'
    const outcome = (status: TurnStatus, error?: string): TurnOutcome => ({
      turnId, status, say, sent, evtApplied, budget, injectedMemoryIds, problems,
      durationMs: this.clock.now() - now, ...(error ? { error } : {}),
    })
    const deliver = async (text: string): Promise<void> => {
      if (sent !== null) return
      say = renderReply(text)
      const current = deps.repos.getSnapshot(binding.principalId)?.snapshot
      if (current) {
        const guarded = await this.expression.guard(say, current, inbound.text, this.clock.now(), undefined, [], binding)
        if (guarded.text === null) { say = null; throw new Error('expression-blocked') }
        say = guarded.text
      }
      const id = `reply_${turnId}`
      deps.repos.enqueueOutbox({ id, conversationId, turnId, candidateKey: `reply:${turnId}`,
        taskId: null, content: say, contentHash: hashKey(say), plannedAtMs: this.clock.now(), expectedInboundSeq: message.seq })
      if (!deps.repos.claimReply(id)) return
      try {
        const receipt = await (inbound.send ?? deps.send)({ conversationId, turnId, text: say, expectedInboundSeq: message.seq })
        sent = ['accepted', 'rejected', 'unknown'].includes(receipt.kind) ? receipt : { kind: 'unknown', code: 'invalid-receipt', atMs: this.clock.now() }
      } catch {
        sent = { kind: 'unknown', code: 'transport-threw', atMs: this.clock.now() }
      }
      deps.repos.finishOutbox(id, sent)
      deps.repos.insertRawMessage({ id: `${conversationId}:out:${turnId}`, conversationId,
        platformMessageKey: sent.platformMessageId ?? null, role: 'assistant', sourceKind: 'companion', content: say,
        occurredAtMs: this.clock.now(), observedAtMs: this.clock.now(), deliveryStatus: sent.kind, deletedAtMs: null })
    }
    try {
      deps.repos.createTurn({ id: turnId, conversation_id: conversationId, session_id: inbound.sessionId,
        inbound_message_id: message.id, state_revision_used: null, status: 'running', started_at_ms: now })
      const stored = deps.repos.getSnapshot(binding.principalId)
      const legacySnapshot = stored === undefined
        ? initialSnapshot(binding.principalId, deps.config.companion.preset, deps.config.affect.ruleVersion, now)
        : projectSnapshot(stored.snapshot, now, deps.config.affect)
      deps.repos.putSnapshot(legacySnapshot, stored?.revision ?? 0)
      const continuous = continuousAffect(deps.repos,deps.config,binding.principalId,now)
      const snapshot = {...legacySnapshot,mood:continuousMood(continuous,legacySnapshot.mood)}
      const retrievalAt = this.clock.now()
      const retrieval = deps.retriever.retrieve({ binding, query: inbound.text, emotionArousal: retrievalArousal(continuous,legacySnapshot.mood), nowMs: now })
      deps.metrics.record(turnId, 'retrieval', this.clock.now() - retrievalAt, this.clock.now())
      const pending = deps.repos.pendingTasks(conversationId, 5)
      const boundaries = renderBoundaries({
        agreements: pending.filter(row => row['kind'] === 'commitment').map(row => String(row['content'])),
        pendingReminders: pending.filter(row => row['kind'] === 'reminder').map(row => String(row['content'])),
        scopeNote: (binding.visibility === 'group' ? '当前是群聊：不得复述私聊资料。' : '当前是本人私聊。') + (deps.deviceText ?? ''),
      })
      const teasing = deps.teasingContext?.(conversationId) ?? false
      const observed = this.strategyObservations.get(message.id)
      const appraisal = currentStrategyAppraisal(deps.repos, binding, message, deps.config.affect,
        observed?.signature === hashKey(message.content) ? observed.appraisals : [], teasing)
      const strategy = decideStrategy({ snapshot, ...(appraisal ? { appraisal } : {}),
        establishedTeasingContext: teasing,
        technicalRequest: looksTechnical(inbound.text), config: deps.config.affect })
      const recent = deps.repos.recentRawMessages(conversationId, 12, message.seq)
        .filter(row => row.role === 'user' || (row.role === 'assistant' && ['accepted', 'sent', 'delivered'].includes(row.deliveryStatus ?? '')))
        .map(row => ({ id: row.id, text: row.content, role: row.role }))
      const prompts = deps.prompts.load(personalityPreset(deps.repos, deps.config, binding.principalId))
      const built = buildContext({ persona: prompts.persona, protocol: prompts.protocol, boundaries, snapshot, recent,
        userText: inbound.text, strategy: [deps.config.expression.mode === 'enforce' ? CORE_POLICY : '', `【本轮倾向】${strategy.prior}`, deps.config.integration.naturalExpression ? renderPlan(this.expression.plan(snapshot, inbound.text, now)) : '',
          deps.config.integration.naturalExpression ? renderInteractionHabits(deps.repos, binding, now) : '',perceptionContext(deps.repos,deps.config,binding,inbound.text,now)].filter(Boolean).join('\n'),
        memoryItems: retrieval.selected, checkpoint: renderCheckpoint(parseCheckpoint(deps.repos.currentCheckpoint(conversationId)?.['summary_json'])),
        counter: this.counter, memoryConfig: deps.config.memory })
      budget = describeBudget(built)
      injectedMemoryIds = built.injectedMemoryIds
      if (!built.measure.report.ok) {
        problems.push('input-budget-exceeded')
        await deliver('这条内容超出了当前聊天的输入上限，请分段发送；原文已保留，这次没有调用模型。')
        deps.repos.updateTurn(turnId, { status: 'failed', say_status: receiptKind(), ended_at_ms: this.clock.now() })
        return outcome('failed', 'input-budget-exceeded')
      }
      const commitBeforeSend = looksLikeReminderRequest(inbound.text) || /记住|以后叫我|以后称呼|回短一点|忘掉|删除记忆|重置关系/u.test(inbound.text)
      const parser = new StreamParser()
      const parts: string[] = []
      const modelAt = this.clock.now()
      let firstToken = true
      modelStarted = true
      try {
        for await (const chunk of deps.callModel({ turnId, systemText: built.measure.final.fullText, userText: inbound.text, thinking: deps.config.generation.thinking })) {
          if (chunk.usage) usage.push(chunk.usage)
          if (!chunk.text) continue
          if (firstToken) {
            deps.metrics.record(turnId, 'provider-first-token', this.clock.now() - modelAt, this.clock.now())
            firstToken = false
          }
          parts.push(chunk.text)
          for (const event of parser.feed(chunk.text)) {
            if (event.type === 'say-closed' && event.text?.trim() && deps.config.generation.sendOnSayClose && !commitBeforeSend) await deliver(event.text)
          }
        }
      } catch (error) {
        parser.cancel()
        problems.push('model-failed')
        if (sent === null) throw error
      }
      const parsed: ParserResult = parser.finish().result
      problems.push(...parsed.problems)
      if (say === null && !parsed.problems.includes('say-unclosed')) say = parsed.say
      if (say === null && deps.config.generation.plainTextFallback && !/<\/?(?:say|evt)\b/i.test(parts.join(''))) {
        say = parts.join('').trim().slice(0, LIMITS.sayChars) || null
        if (say) problems.push('plain-fallback')
      }
      if (parsed.evtRaw !== null) {
        const validation = parseEvt(parsed.evtRaw)
        if (validation.ok && this.counter.count(parsed.evtRaw) <= deps.config.generation.metadataHardLimitTokens) {
          evtApplied = await this.applyEvt(turnId, binding, inbound, message, validation.payload, snapshot, problems)
        } else problems.push('evt-invalid')
      }
      if (commitBeforeSend && (!evtApplied || problems.some(item => /^(reminder-|memory-|evt-apply-failed|evt-invalid)/.test(item)))) {
        say = '这次没有完成保存或设置操作，请补充明确的信息，或使用 /fish 管理命令。'
        problems.push('operation-not-committed')
      }
      if (sent === null && say?.trim()) await deliver(say)
      if (!inbound.review) this.scheduleConsolidation(binding, conversationId, message.seq)
      deps.repos.updateTurn(turnId, { status: say === null ? 'failed' : 'completed', say_status: receiptKind(),
        tail_status: evtApplied ? 'applied' : problems.includes('model-failed') ? 'pending' : parsed.evtRaw === null ? 'not_expected' : 'rejected', ended_at_ms: this.clock.now() })
      return outcome(say === null ? 'failed' : evtApplied ? 'completed' : 'say-only')
    } catch (error) {
      deps.metrics.degrade(`回合失败：${describeError(error)}`)
      deps.repos.updateTurn(turnId, { status: 'failed', tail_status: sent ? 'pending' : 'rejected', ended_at_ms: this.clock.now() })
      return outcome('failed', describeError(error))
    } finally {
      if (modelStarted) {
        const last = usage.at(-1)
        deps.ledger.record({ turnId, phase: 'foreground', provider: last?.provider ?? 'host', model: last?.model ?? 'host-default',
          inputTokens: last?.inputTokens ?? 'unknown', outputTokens: last?.outputTokens ?? 'unknown', cacheHitTokens: last?.cacheHitTokens ?? 'unknown',
          cacheMissTokens: last?.cacheMissTokens ?? 'unknown', reasoningTokens: last?.reasoningTokens ?? 'unknown', retry: 0, atMs: this.clock.now() })
      }
    }
  }

  /**
   * 应用 evt。返回是否至少应用成功了一个事。候。任务。
   *
   * 来源绑定（。7.2）：模型产出。e 项一律绑定到**当前这条用户消息**。
   * 它自己给的任。id 字段。validateEvt 阶段已被剔除。
   */
  private async applyEvt(
    turnId: string,
    binding: IdentityBinding,
    inbound: InboundTurn,
    message: RawMessage,
    payload: EvtPayload,
    snapshotBefore: ReturnType<typeof initialSnapshot>,
    problems: string[],
    producer: 'live_tail' | 'background_observer' | 'local_rule' = 'live_tail',
  ): Promise<boolean> {
    const deps = this.deps
    const now = this.clock.now()
    let applied = false
    const teasing = deps.teasingContext?.(binding.conversationId) ?? false


    for (const [index, event] of payload.e.map((e, i) => [i, e] as const)) {
      if (['insult', 'teasing', 'boundary'].includes(event.k) && /别人说|他说|她说|引用|台词|比如|例如|假如/.test(message.content) && !/我就是(?:在)?骂你|我(?:刚才)?说你/.test(message.content)) { problems.push('evt-skip:quoted-or-hypothetical'); continue }
      if (!EVENT_KINDS.includes(event.k)) {
        problems.push(`evt-kind-not-allowed:${event.k}`)
        continue
      }
      const appraisal: ValidatedAppraisal = {
        sourceMessageId: message.id,
        kind: event.k,
        intent: event.i,
        target: event.to,
        severity: event.s,
        confidence: event.c,
        evidenceQuote: event.k === 'neutral' ? undefined : inbound.text.slice(0, 100),
        source: producer === 'live_tail' ? 'live_tail' : 'background',
        revision: index,
      }
      const eligibility = checkEligibility(
        {
          appraisal,
          fromInboundUserMessage: true,
          establishedTeasingContext: teasing,
          roleplay: false,
        },
        deps.config.affect,
      )
      const localRevision=deps.repos.db.get<{n:number|null}>("SELECT MAX(revision) n FROM appraisals WHERE source_message_id=? AND producer='local_rule'",message.id)?.n
      const upgrade = producer === 'background_observer' && localRevision!==null && localRevision!==undefined ? ':background-upgrade' : ''
      const idempotencyKey = `${message.id}:${event.k}:${event.to}:${index}${upgrade}`
      const appraisalId = `ap_${hashKey(idempotencyKey)}`
      deps.repos.insertAppraisal({ id: appraisalId, sourceMessageId: message.id, revision: upgrade ? localRevision!+1+index : index,
        kind: event.k, intent: event.i, target: event.to, severity: event.s, confidence: event.c,
        evidenceQuote: appraisal.evidenceQuote ?? null, producer,
        status: eligibility.eligible || eligibility.softMoodOnly ? 'active' : 'pending', createdAtMs: now })
      if (!eligibility.eligible && !eligibility.softMoodOnly) {
        problems.push(`evt-skip:${eligibility.reason}`)
        continue
      }

      const seen = new Set<string>()
      for (const row of deps.repos.activeAffectEvents(binding.principalId)) {
        const key = row['idempotency_key']
        if (typeof key === 'string') seen.add(key)
      }
      if (seen.has(idempotencyKey)) {
        problems.push('evt-duplicate')
        continue
      }

      try {
        deps.repos.db.transaction(() => {
        const openEpisodes = deps.repos.listEpisodes(binding.principalId, ['open', 'repairing'], 20)
        const target = openEpisodes.find(episode => episode.conversationId === binding.conversationId && worthMentioning(episode))
        const current = deps.repos.getSnapshot(binding.principalId)
        const previous = current === undefined ? snapshotBefore : projectSnapshot(current.snapshot, now, deps.config.affect)
        const episodeContext = target === undefined
          ? undefined
          : {
              id: target.id,
              kind: target.kind,
              status: target.status,
              lastEventAtMs: target.lastEventAtMs,
              uniqueMessageCount: target.sourceMessageIds.length,
              appliedDeltas: target.appliedDeltas,
            }
        const reduced = reduce(
          previous,
          { ...appraisal, occurredAtMs: message.occurredAtMs },
          this.clock,
          deps.config.affect,
          {
            dailyUsed: dailyUsage(deps.repos.activeAffectEvents(binding.principalId), message.occurredAtMs, deps.config),
            episode: episodeContext,
            fromInboundUserMessage: true,
            establishedTeasingContext: teasing,
            roleplay: false,
            idempotencyKey,
            seenIdempotencyKeys: seen,
          },
        )

        // episode 必须先落库：affect_events.episode_id 有外键，新建 episode 。
        // 「先写事件」会因为外键失败而整条事件丢失（回放里表现为 evt-apply-failed）。
        const isNew = reduced.episode.isNew
        const existing = isNew ? undefined : deps.repos.getEpisode(reduced.episode.id)
        const appliedDeltas = addDelta(existing?.appliedDeltas ?? emptyDelta(), reduced.episode.deltaToApply)
        const record: EpisodeRecord = {
          id: reduced.episode.id,
          principalId: binding.principalId,
          conversationId: binding.conversationId,
          kind: reduced.episode.kind,
          status: reduced.episode.status,
          sourceMessageIds: existing === undefined ? [message.id] : [...new Set([...existing.sourceMessageIds, message.id])],
          appliedDeltas,
          startedAtMs: existing?.startedAtMs ?? message.occurredAtMs,
          lastEventAtMs: message.occurredAtMs,
          summary: existing?.summary ?? `来自 ${inbound.text.slice(0, 40)}`,
        }
        if (isNew) deps.repos.upsertEpisode(record, true)

        // 先写事件（幂等键唯一），再推快照：顺序保证崩溃后不会「扣了分没有记录。
        const eventInsert = deps.repos.appendAffectEvent({
          id: `ae_${hashKey(idempotencyKey)}`,
          principalId: binding.principalId,
          conversationId: binding.conversationId,
          appraisalId,
          episodeId: reduced.episode.id === 'none' ? null : reduced.episode.id,
          idempotencyKey,
          eventTimeMs: message.occurredAtMs,
          payload: { appraisal, explanations: reduced.explanations, scale: reduced.scale, relationshipDelta: reduced.episode.deltaToApply, teasing, roleplay: false },
          ruleVersion: deps.config.affect.ruleVersion,
          status: 'active',
          createdAtMs: now,
        })
        if (!eventInsert.inserted) return

        const nextSnapshot = {
          ...reduced.next,
          revision: previous.revision + 1,
          projectedThroughSeq: Math.max(previous.projectedThroughSeq, message.seq),
          asOfMs: now,
        }
        deps.repos.putSnapshot(nextSnapshot, current?.revision ?? 0)

        // episode 落库：新。/ 更新只应用差额（§8.7。
        if (record.id !== 'none') deps.repos.upsertEpisode(record, false)
        applied = true
        annotateEpisode(deps.repos, binding.principalId, appraisal, now)

        // 修复意图：把 open episode 推到 repairing
        if (target !== undefined && isRepairIntent(event.i, event.k)) {
          deps.repos.upsertEpisode(transition(deps.repos.getEpisode(target.id) ?? target, 'repairing', now), false)
        }
        })
      } catch (error) {
        problems.push(`evt-apply-failed:${describeError(error)}`)
      }
    }

    // 记忆候选（§10.1）：一条，必须能引用当前消息原。
    for (const hint of payload.m ?? []) {
      if (!MEMORY_HINTS.includes(hint.k)) {
        problems.push(`memory-kind-not-allowed:${hint.k}`)
        continue
      }
      const quote = matchSourceQuote(inbound.text, hint.q)
      if (quote === null) {
        problems.push('memory-quote-not-found')
        continue
      }
      const outcome = deps.updater.write({
        id: reuseOwnerMemoryId(deps.repos, binding.principalId, principal => `mem_${hashKey(`${principal}:${hint.k}:${hint.t}`)}`),
        principalId: binding.principalId,
        conversationId: binding.conversationId,
        visibility: binding.visibility,
        kind: hint.k,
        subject: null,
        predicate: null,
        object: { text: hint.t },
        claim: hint.t.slice(0, 100),
        sourceKind: producer,
        confidence: 0.7,
        salience: 0.6,
        eventAtMs: message.occurredAtMs,
        observedAtMs: now,
        evidence: [{ messageId: message.id, quote: quote.slice(0, 200) }],
        lexicalTerms: undefined,
      } as never)
      if (outcome.type === 'inserted' || outcome.type === 'unchanged') applied = true
      else if (outcome.type === 'rejected') problems.push(`memory-write-failed:${outcome.reason}`)
    }

    // 提醒候选（§27.3）：默认 proposed，时间解析失败就不建精确时刻
    for (const reminder of payload.t ?? []) {
      if (inbound.review) { problems.push('reminder-disabled-in-review'); continue }
      if (reminder.k !== 'reminder') continue
      if (!looksLikeReminderRequest(inbound.text) || !normalizeForMatch(inbound.text).includes(normalizeForMatch(reminder.q))) {
        problems.push('reminder-source-mismatch')
        continue
      }
      const sourceTime = parseWhen(inbound.text, { nowMs: now, timezone: deps.config.proactive.timezone, text: inbound.text })
      const when = reminder.when ?? inbound.text
      const parsedWhen = when.length > 0
        ? parseWhen(when, { nowMs: now, timezone: deps.config.proactive.timezone, text: inbound.text })
        : ({ ok: false, reason: 'missing-time', detail: '没有给出时间' } as const)
      const dueAt = parsedWhen.ok && sourceTime.ok && Math.abs(parsedWhen.atMs - sourceTime.atMs) < 60_000 ? parsedWhen.atMs : null
      const taskId = `task_${hashKey(`${message.id}:${reminder.text}`)}`
      try {
        deps.repos.insertTask({
          id: taskId,
          principalId: binding.principalId,
          conversationId: binding.conversationId,
          sourceMessageId: message.id,
          kind: 'reminder',
          content: reminder.text.slice(0, 100),
          status: dueAt === null ? 'proposed' : 'confirmed',
          dueAtMs: dueAt,
          timezone: deps.config.proactive.timezone,
          expiresAtMs: dueAt === null ? null : dueAt + 24 * 60 * 60_000,
          createdAtMs: now,
        })
        applied = true
        if (dueAt === null) problems.push('reminder-time-unresolved')
      } catch (error) {
        problems.push(`reminder-insert-failed:${describeError(error)}`)
      }
    }

    // 连续性诊断（§9.3）：只记录，不触发第二次模型调用
    if (payload.a !== undefined && problems.length === 0) {
      const issues = checkContinuity(undefined, '', snapshotBefore)
      if (issues.length > 0) problems.push(...issues)
    }

    deps.repos.audit({
      principalId: binding.principalId,
      kind: 'evt-applied',
      entityId: turnId,
      payload: { events: payload.e.length, action: payload.a ?? null, applied, problems },
      createdAtMs: now,
    })
    return applied
  }

  private scheduleConsolidation(binding: IdentityBinding, conversationId: string, afterSeq: number): void {
    const bg = this.deps.background
    if (bg === undefined) return
    scheduleConsolidation(this.deps.repos, this.deps.config, bg, conversationId, binding.principalId, this.clock.now())
    void afterSeq

  }

  /** 供命令与测试使用的「纯正文」路径：不调模型，直接把文本发出去。*/
  async sendPlain(chatId: string, binding: IdentityBinding, text: string, turnId: string): Promise<DeliveryReceipt> {
    void chatId
    return this.deps.send({
      conversationId: binding.conversationId,
      turnId,
      text,
      expectedInboundSeq: this.deps.repos.latestInboundSeq(binding.conversationId),
    })
  }
}

function looksTechnical(text: string): boolean {
  return /[A-Za-z_][A-Za-z0-9_]{2,}|```|报错|错误|异常|端口|版本|编译|安装|配置|API|SQL|正则/.test(text)
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function addDelta(a: RelationshipDelta, b: RelationshipDelta): RelationshipDelta {
  return {
    affection: a.affection + b.affection,
    trust: a.trust + b.trust,
    respect: a.respect + b.respect,
    grievance: a.grievance + b.grievance,
  }
}

function parseCheckpoint(raw: unknown): { topic?: string; openItems?: string[]; nextStep?: string } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as { topic?: unknown; openItems?: unknown; nextStep?: unknown }
    return {
      topic: typeof record.topic === 'string' ? record.topic : undefined,
      openItems: Array.isArray(record.openItems) ? record.openItems.filter((x): x is string => typeof x === 'string') : undefined,
      nextStep: typeof record.nextStep === 'string' ? record.nextStep : undefined,
    }
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + ': ' + error.message
  return String(error)
}

