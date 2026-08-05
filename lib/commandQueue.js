// lib/commandQueue.js
// Per-user command queue — optimized for high concurrency.
// Each user gets their own async FIFO queue.
// Light commands bypass queue entirely; heavy commands queue per user.

'use strict'

class UserQueue {
    constructor(concurrency = 1) {
        this._tasks = []
        this._concurrency = concurrency
        this._active = 0
        this._lastActive = Date.now()
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            if (typeof task !== 'function') {
                reject(new TypeError(`UserQueue.enqueue expected a function task, got ${typeof task}`))
                return
            }

            this._tasks.push({ task, resolve, reject })
            this._lastActive = Date.now()
            setImmediate(() => this._drain())
        })
    }

    async _drain() {
        while (this._active < this._concurrency && this._tasks.length > 0) {
            const entry = this._tasks.shift()
            const { task, resolve, reject } = entry

            if (typeof task !== 'function') {
                reject(new TypeError(`UserQueue._drain expected a function task, got ${typeof task}`))
                continue
            }

            this._active += 1
            this._lastActive = Date.now()
            if (process.env.DEBUG_COMMANDS === '1') {
                console.log(`[queue] Starting task (active=${this._active})`, { taskType: typeof task })
            }

            task()
                .then(result => resolve(result))
                .catch(err => reject(err))
                .finally(() => {
                    this._active -= 1
                    this._lastActive = Date.now()
                    if (process.env.DEBUG_COMMANDS === '1') {
                        console.log(`[queue] Task finished (active=${this._active})`)
                    }
                    setImmediate(() => this._drain())
                })
        }
    }

    get lastActive() { return this._lastActive }
}

class CommandQueue {
    constructor(options = {}) {
        this._queues = new Map()
           this._maxConcurrent = Number(process.env.MAX_CONCURRENT_USERS) || 1000
        this._taskTimeout = options.taskTimeoutMs || 60_000
           this._perUserConcurrency = Number(process.env.PER_USER_CONCURRENCY) || 8
           this._taskTimeout = Number(process.env.TASK_TIMEOUT_MS) || 60_000

        // Prune idle queues every 2 min
        setInterval(() => this._pruneIdle(), 30 * 1000).unref()
    }

    run(userId, task) {
        if (typeof task !== 'function') {
            return Promise.reject(new TypeError(`CommandQueue.run expected a function task, got ${typeof task}`))
        }
        if (!this._queues.has(userId)) {
            this._queues.set(userId, new UserQueue(this._perUserConcurrency))
        }
        const queue = this._queues.get(userId)

        if (process.env.DEBUG_COMMANDS === '1') {
            console.log(`[queue] Enqueued task for ${userId}; queueSize=${queue._tasks.length + 1}`, { taskType: typeof task, task })
        }

        const originalTask = task
        const timedTask = () => {
            return new Promise(async (resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('Command timed out'))
                }, this._taskTimeout)

                try {
                    if (process.env.DEBUG_COMMANDS === '1') {
                        console.log('[queue] executing timedTask', { taskType: typeof originalTask, task: originalTask })
                    }
                    const result = await originalTask()
                    clearTimeout(timer)
                    resolve(result)
                } catch (err) {
                    clearTimeout(timer)
                    reject(err)
                }
            })
        }

        return queue.enqueue(timedTask)
    }

    _pruneIdle() {
        const now = Date.now()
        for (const [userId, q] of this._queues) {
            // Remove queues that are idle (no active tasks, no queued tasks) for >60s
            try {
                if (q._active === 0 && q._tasks.length === 0 && (now - (q.lastActive || 0) > 60_000)) {
                    this._queues.delete(userId)
                }
            } catch (e) {
                // Defensive: if queue shape changed, just continue
            }
        }
    }

    get activeUsers() { return this._queues.size }
}

    module.exports = new CommandQueue({
        maxConcurrentUsers: Number(process.env.MAX_CONCURRENT_USERS) || 1000,
        taskTimeoutMs: Number(process.env.TASK_TIMEOUT_MS) || 60_000,
        perUserConcurrency: Number(process.env.PER_USER_CONCURRENCY) || 8,
    })

