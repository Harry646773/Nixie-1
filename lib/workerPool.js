"use strict"

const { fork } = require('child_process')
const os = require('os')
const path = require('path')

class WorkerPool {
  constructor(count) {
    this.count = Number(count) || Math.max(1, Math.min(4, os.cpus().length - 1 || 1))
    this.workers = []
    this.nextId = 1
    this.pending = new Map()
    this._spawnAll()
  }

  _spawnAll() {
    for (let i = 0; i < this.count; i++) this._spawnWorker()
  }

  _spawnWorker() {
    const id = this.workers.length
    const child = fork(path.join(__dirname, 'workerChild.js'))
    const worker = { id, child, tasks: 0 }

    child.on('message', (msg) => {
      const { id: msgId, ok, result, error } = msg || {}
      const promise = this.pending.get(msgId)
      if (!promise) return
      this.pending.delete(msgId)
      worker.tasks = Math.max(0, worker.tasks - 1)
      if (ok) promise.resolve(result)
      else promise.reject(new Error(error || 'Worker error'))
    })

    child.on('exit', (code, sig) => {
      // requeue pending tasks? simply respawn worker
      try { const idx = this.workers.indexOf(worker); if (idx !== -1) this.workers.splice(idx, 1) } catch {}
      setTimeout(() => this._spawnWorker(), 1000)
    })

    this.workers.push(worker)
    return worker
  }

  runTask(taskName, payload = {}) {
    if (this.workers.length === 0) this._spawnAll()
    const least = this.workers.reduce((a, b) => (a.tasks <= b.tasks ? a : b), this.workers[0])
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        least.tasks += 1
        least.child.send({ id, task: taskName, payload })
      } catch (e) {
        least.tasks = Math.max(0, least.tasks - 1)
        this.pending.delete(id)
        reject(e)
      }
    })
  }
}

module.exports = new WorkerPool(process.env.WORKER_COUNT || 2)
