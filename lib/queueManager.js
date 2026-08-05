// ════════════════════════════════════════════════════════════════════
// QUEUE MANAGER - Per-User Download Queue System
// ════════════════════════════════════════════════════════════════════

const EventEmitter = require('events').EventEmitter

class TaskQueue {
  constructor(userId, maxConcurrent = 1) {
    this.userId = userId
    this.maxConcurrent = maxConcurrent
    this.tasks = []
    this.active = 0
    this.emitter = new EventEmitter()
  }

  async push(task) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ task, resolve, reject })
      this._process()
    })
  }

  async _process() {
    while (this.active < this.maxConcurrent && this.tasks.length > 0) {
      const { task, resolve, reject } = this.tasks.shift()
      this.active++

      try {
        const result = await task()
        resolve(result)
      } catch (error) {
        reject(error)
      } finally {
        this.active--
        if (this.tasks.length > 0) {
          this._process()
        }
      }
    }
  }

  size() {
    return this.tasks.length + this.active
  }

  pending() {
    return this.tasks.length
  }

  isProcessing() {
    return this.active > 0
  }

  clear() {
    this.tasks = []
  }
}

class QueueManager {
  constructor() {
    this.queues = new Map()
    this.stats = {
      totalProcessed: 0,
      totalFailed: 0,
      totalQueued: 0
    }
  }

  getQueue(userId) {
    if (!this.queues.has(userId)) {
      this.queues.set(userId, new TaskQueue(userId, 1))
    }
    return this.queues.get(userId)
  }

  async enqueue(userId, task) {
    const queue = this.getQueue(userId)
    this.stats.totalQueued++
    
    try {
      const result = await queue.push(task)
      this.stats.totalProcessed++
      return result
    } catch (error) {
      this.stats.totalFailed++
      throw error
    }
  }

  getPending(userId) {
    const queue = this.queues.get(userId)
    return queue ? queue.pending() : 0
  }

  getQueueSize(userId) {
    const queue = this.queues.get(userId)
    return queue ? queue.size() : 0
  }

  isProcessing(userId) {
    const queue = this.queues.get(userId)
    return queue ? queue.isProcessing() : false
  }

  clearQueue(userId) {
    const queue = this.queues.get(userId)
    if (queue) {
      queue.clear()
    }
  }

  getStats() {
    return {
      ...this.stats,
      activeQueues: this.queues.size
    }
  }

  cleanup() {
    // Remove idle queues after 1 hour
    const now = Date.now()
    const IDLE_THRESHOLD = 3600000 // 1 hour

    for (const [userId, queue] of this.queues.entries()) {
      if (queue.size() === 0) {
        this.queues.delete(userId)
      }
    }
  }

  // Periodic cleanup
  startCleanupInterval() {
    this._cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 1800000) // Every 30 minutes
  }

  stopCleanupInterval() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval)
    }
  }
}

const queueManager = new QueueManager()
queueManager.startCleanupInterval()

module.exports = {
  queueManager,
  TaskQueue,
  QueueManager
}
