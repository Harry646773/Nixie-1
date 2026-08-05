"use strict"

process.on('uncaughtException', (e) => {
  try { process.send({ id: 'ERR', ok: false, error: e?.message || String(e) }) } catch {}
})

process.on('message', async (msg) => {
  const { id, task, payload } = msg || {}
  try {
    const handlers = require('./workerHandlers')
    if (!handlers[task] || typeof handlers[task] !== 'function') {
      throw new Error(`Unknown worker task: ${task}`)
    }
    const result = await handlers[task](payload || {})
    process.send({ id, ok: true, result })
  } catch (err) {
    process.send({ id, ok: false, error: err?.message || String(err) })
  }
})
