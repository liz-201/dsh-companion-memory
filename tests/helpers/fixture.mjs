import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { resolveConfig } from '../../lib/config.js'
import { PRESETS } from '../../lib/domain/affect-reducer.js'
import { openDatabase } from '../../lib/storage/database.js'
import { migrate } from '../../lib/storage/migrations.js'
import { Repositories } from '../../lib/storage/repositories.js'
import { FactUpdater } from '../../lib/memory/fact-updater.js'
import { Retriever } from '../../lib/memory/retriever.js'
import { ConversationQueue } from '../../lib/runtime/conversation-queue.js'
import { Metrics } from '../../lib/runtime/metrics.js'
import { TokenLedger } from '../../lib/runtime/context-budget.js'
import { PromptStore } from '../../lib/runtime/context-builder.js'
import { TurnCoordinator } from '../../lib/runtime/turn-coordinator.js'
import { handleFishCommand } from '../../lib/commands/handlers.js'

export function fixture(options = {}) {
  const config = resolveConfig(options.config ?? {})
  const directory = mkdtempSync(join(tmpdir(), 'companion-regression-'))
  const db = openDatabase({ ...config.storage, directory }, false, 'fixture')
  let now = Date.parse('2026-10-23T02:00:00Z')
  migrate(db, { now, fts5: true })
  const repos = new Repositories(db)
  repos.ensureCompanion(config.companion.id, 'fixture', PRESETS[config.companion.preset], now)
  repos.ensurePrincipal('p', config.companion.id, 'bot', 'user', now)
  repos.ensureConversation('c', 'p', 'private', 'private:123', now)
  const binding = { companionId: config.companion.id, botAccountId: 'bot', userId: 'user', conversationId: 'c', principalId: 'p', conversationKind: 'private', visibility: 'private' }
  const updater = new FactUpdater(repos, config.memory)
  const retriever = new Retriever(repos, config.memory)
  const queue = new ConversationQueue()
  const metrics = new Metrics()
  const ledger = new TokenLedger()
  const requests = [], sends = []
  let sequence = 0, calls = 0
  const coordinator = new TurnCoordinator({ config, repos, updater, retriever, queue, metrics, ledger, prompts: new PromptStore(), clock: { now: () => now },
    send: async request => {
      sends.push(request)
      return options.send ? options.send(request) : { kind: 'accepted', atMs: now, platformMessageId: `out-${sends.length}` }
    },
    callModel: async function* (request) {
      requests.push(request)
      if (options.callModel) { yield* options.callModel(request); return }
      const event = options.events?.[calls++]
      yield { text: '<say>收到</say>' }
      if (event) yield { text: `<evt>${JSON.stringify({ v: 1, e: [event] })}</evt>` }
    },
  })
  return { config, directory, db, repos, updater, retriever, metrics, ledger, binding, requests, sends,
    now: () => now, advance: ms => { now += ms }, snapshot: () => repos.getSnapshot('p')?.snapshot,
    turn: (text = '测试输入', extra = {}) => coordinator.handleInbound({ binding, chatId: 'private:123', text, platformMessageKey: `in-${sequence++}`, occurredAtMs: now, observedAtMs: now, sessionId: 'session', ...extra }),
    command: raw => handleFishCommand({ raw, binding, isOwner: true, nowMs: now }, { config, db, repos, updater, retriever, metrics }),
    close() {
      queue.close()
      db.close()
      const path = resolve(directory)
      if (!path.startsWith(resolve(tmpdir()) + sep) || !path.split(sep).at(-1).startsWith('companion-regression-')) throw new Error('Unsafe fixture cleanup')
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    },
  }
}

export const insult = { k: 'insult', to: 'self', i: 'hostile', s: 3, c: 0.99 }
export const appreciation = { k: 'appreciation', to: 'self', i: 'neutral', s: 3, c: 0.99 }
