/**
 * 同一会话串行队列（任务书 §6.1）。
 *
 * 硬规则：
 *   · 同一 conversationId 内严格 FIFO，前一轮没结束就不开下一轮；
 *   · 不同会话互不阻塞；
 *   · 排队有上限，满了要明确拒绝（返回 queued:false + 原因），不能无限堆积；
 *   · 每个任务都有 turnId，重复投递同一个 turnId 直接去重（重连、重试都靠它）；
 *   · 队列关闭（卸载 / 热重载）后新任务一律拒绝，已在跑的允许跑完并清理计时器。
 */

import type { QueuedTurnTask } from '../domain/types.js'

export interface QueueOptions {
  /** 每个会话最多排队多少个待处理任务（不含正在跑的）。 */
  maxPendingPerConversation?: number
  /** 等待超时（毫秒）；超时的任务直接拒绝，避免永久挂起。 */
  waitTimeoutMs?: number
}

export interface EnqueueResult {
  queued: boolean
  /** 已在队列中的话返回其位置（0 = 下一个就轮到它）。 */
  position: number
  /** 与 turnId 相同的任务已在队列里，这次是幂等重复。 */
  duplicate: boolean
  reason?: 'closed' | 'full' | 'timeout'
}

export interface QueueStats {
  conversations: number
  running: number
  pending: number
  dropped: number
  completed: number
  failed: number
}

interface Waiter {
  task: QueuedTurnTask
  resolve: () => void
  reject: (error: Error) => void
  enqueuedAtMs: number
  timer: ReturnType<typeof setTimeout> | null
}

interface Lane {
  queue: Waiter[]
  running: boolean
}

export class ConversationQueue {
  private readonly lanes = new Map<string, Lane>()
  private readonly maxPending: number
  private readonly waitTimeoutMs: number
  private closed = false
  private dropped = 0
  private completed = 0
  private failed = 0

  constructor(options: QueueOptions = {}) {
    this.maxPending = options.maxPendingPerConversation ?? 8
    this.waitTimeoutMs = options.waitTimeoutMs ?? 120_000
  }

  /** 排队并等待执行完成；调用方 await 它即可拿到这一轮的结束点。 */
  async run(task: QueuedTurnTask): Promise<EnqueueResult> {
    if (this.closed) return { queued: false, position: 0, duplicate: false, reason: 'closed' }
    const lane = this.lane(task.conversationId)
    if (lane.queue.some((waiter) => waiter.task.turnId === task.turnId)) {
      return { queued: true, position: 0, duplicate: true }
    }
    if (lane.queue.length >= this.maxPending) {
      this.dropped += 1
      return { queued: false, position: 0, duplicate: false, reason: 'full' }
    }
    return await new Promise<EnqueueResult>((resolve, reject) => {
      const waiter: Waiter = {
        task,
        resolve: () => resolve({ queued: true, position: 0, duplicate: false }),
        reject,
        enqueuedAtMs: Date.now(),
        timer: null,
      }
      waiter.timer = setTimeout(() => {
        const index = lane.queue.indexOf(waiter)
        if (index >= 0) {
          lane.queue.splice(index, 1)
          this.dropped += 1
          reject(new Error(`队列等待超时：turn ${task.turnId}`))
        }
      }, this.waitTimeoutMs)
      // 计时器不应该拖住宿主进程退出。
      if (typeof waiter.timer === 'object' && waiter.timer !== null && 'unref' in waiter.timer) {
        ;(waiter.timer as { unref(): void }).unref()
      }
      lane.queue.push(waiter)
      void this.pump(task.conversationId, lane)
    })
  }

  /** 只排队不等待（后台任务、主动消息用）。 */
  enqueue(task: QueuedTurnTask): EnqueueResult {
    if (this.closed) return { queued: false, position: 0, duplicate: false, reason: 'closed' }
    const lane = this.lane(task.conversationId)
    if (lane.queue.some((waiter) => waiter.task.turnId === task.turnId)) {
      return { queued: true, position: 0, duplicate: true }
    }
    if (lane.queue.length >= this.maxPending) {
      this.dropped += 1
      return { queued: false, position: 0, duplicate: false, reason: 'full' }
    }
    const position = lane.queue.length
    const waiter: Waiter = {
      task,
      resolve: () => undefined,
      reject: () => undefined,
      enqueuedAtMs: Date.now(),
      timer: null,
    }
    lane.queue.push(waiter)
    void this.pump(task.conversationId, lane)
    return { queued: true, position, duplicate: false }
  }

  /** 是否正在处理某个会话（主动消息调度前要查）。 */
  isBusy(conversationId: string): boolean {
    const lane = this.lanes.get(conversationId)
    return lane !== undefined && (lane.running || lane.queue.length > 0)
  }

  /** 取消某个 turn 的排队（用户撤回、任务过期）。正在跑的不动。 */
  cancel(conversationId: string, turnId: string): boolean {
    const lane = this.lanes.get(conversationId)
    if (lane === undefined) return false
    const index = lane.queue.findIndex((waiter) => waiter.task.turnId === turnId)
    if (index < 0) return false
    const [waiter] = lane.queue.splice(index, 1)
    if (waiter?.timer !== null && waiter?.timer !== undefined) clearTimeout(waiter.timer)
    waiter?.reject(new Error(`任务已被取消：${turnId}`))
    return true
  }

  stats(): QueueStats {
    let pending = 0
    let running = 0
    for (const lane of this.lanes.values()) {
      pending += lane.queue.length
      if (lane.running) running += 1
    }
    return {
      conversations: this.lanes.size,
      running,
      pending,
      dropped: this.dropped,
      completed: this.completed,
      failed: this.failed,
    }
  }

  /** 卸载 / 热重载：拒绝新任务，清空等待中的计时器与 rejected promise。 */
  close(): void {
    this.closed = true
    for (const lane of this.lanes.values()) {
      for (const waiter of lane.queue) {
        if (waiter.timer !== null) clearTimeout(waiter.timer)
        waiter.reject(new Error('队列已关闭'))
      }
      lane.queue.length = 0
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  private lane(conversationId: string): Lane {
    let lane = this.lanes.get(conversationId)
    if (lane === undefined) {
      lane = { queue: [], running: false }
      this.lanes.set(conversationId, lane)
    }
    return lane
  }

  private async pump(conversationId: string, lane: Lane): Promise<void> {
    if (lane.running) return
    const waiter = lane.queue.shift()
    if (waiter === undefined) return
    lane.running = true
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer)
      waiter.timer = null
    }
    try {
      await waiter.task.run()
      this.completed += 1
      waiter.resolve()
    } catch (error) {
      this.failed += 1
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
    } finally {
      lane.running = false
      if (!this.closed && lane.queue.length > 0) {
        void this.pump(conversationId, lane)
      } else if (lane.queue.length === 0) {
        this.lanes.delete(conversationId)
      }
    }
  }
}
