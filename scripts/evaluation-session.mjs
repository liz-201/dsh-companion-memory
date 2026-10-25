import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CORE_POLICY } from '../lib/expression/policy.js'

/** Execute the selected release's actual coordinator in an isolated in-memory database. */
export async function evaluateTurn({ root, variant, item, state, generate }) {
  const load = file => import(pathToFileURL(path.resolve(root, 'lib', file)))
  const [{ resolveConfig }, { openDatabase }, { migrate }, { Repositories }, { FactUpdater }, { Retriever }, { ConversationQueue }, { Metrics }, { TokenLedger }, { PromptStore }, { TurnCoordinator }] = await Promise.all([
    load('config.js'), load('storage/database.js'), load('storage/migrations.js'), load('storage/repositories.js'), load('memory/fact-updater.js'), load('memory/retriever.js'), load('runtime/conversation-queue.js'), load('runtime/metrics.js'), load('runtime/context-budget.js'), load('runtime/context-builder.js'), load('runtime/turn-coordinator.js'),
  ])
  const config = resolveConfig({ proactive: { enabled: false } })
  const db = openDatabase(config.storage, true), queue = new ConversationQueue()
  const requests = [], delivered = []
  try {
    migrate(db, { now: item.nowMs, fts5: true })
    const repos = new Repositories(db)
    repos.ensureCompanion(config.companion.id, 'evaluation', state.personality, item.nowMs)
    repos.ensurePrincipal(state.principalId, config.companion.id, 'evaluation', 'owner', item.nowMs)
    repos.ensureConversation('evaluation', state.principalId, 'private', 'evaluation', item.nowMs)
    repos.putSnapshot({ ...state, revision: 1 }, 0)
    if (variant === 'full') {
      const { PersonalityProfiles } = await load('storage/personality-profiles.js')
      new PersonalityProfiles(repos).configure(config.companion.id, 'builtin', state.personality, { mix: item.personaMix, overrides: item.traitsOverrides, variation: { enabled: false, maxDelta: .05, seed: null } }, item.nowMs)
    }
    for (const [index, message] of item.priorMessages.entries()) repos.insertRawMessage({ id: message.id, conversationId: 'evaluation', platformMessageKey: message.id, role: message.role, sourceKind: 'evaluation', content: message.text, occurredAtMs: item.nowMs - 1000 + index, observedAtMs: item.nowMs - 1000 + index, deliveryStatus: message.role === 'assistant' ? 'accepted' : null, deletedAtMs: null })
    const updater = new FactUpdater(repos, config.memory)
    const coordinator = new TurnCoordinator({ config, repos, updater, retriever: new Retriever(repos, config.memory), queue, metrics: new Metrics(), ledger: new TokenLedger(), prompts: new PromptStore(path.resolve(root, 'prompts')), clock: { now: () => item.nowMs },
      send: async request => { delivered.push(request.text); return { kind: 'accepted', atMs: item.nowMs, platformMessageId: `evaluation-${delivered.length}` } },
      callModel: async function* (request) {
        const phase = request.turnId.startsWith('repair:') ? 'repair' : 'main'
        const result = await generate({ system: request.systemText + (variant === 'prompt' ? '\n' + CORE_POLICY : ''), user: request.userText, phase })
        if (!result || typeof result.text !== 'string') throw new Error('Invalid model adapter output')
        requests.push({ phase, usage: result.usage ?? 'unknown' })
        yield { text: result.text, ...(result.usage ? { usage: result.usage } : {}) }
      },
    })
    const binding = { companionId: config.companion.id, botAccountId: 'evaluation', userId: 'owner', conversationId: 'evaluation', principalId: state.principalId, conversationKind: 'private', visibility: 'private' }
    const outcome = await coordinator.handleInbound({ binding, chatId: 'private:evaluation', text: item.userInput, platformMessageKey: item.id, occurredAtMs: item.nowMs, observedAtMs: item.nowMs, sessionId: 'evaluation' })
    return { output: delivered.at(-1) ?? null, status: outcome.status, problems: outcome.problems, error: outcome.error ?? null, requests }
  } finally { queue.close(); db.close() }
}
