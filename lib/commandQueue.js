const queues = new Map()

function _getQueueKey(userId) {
  return userId ? String(userId) : '__global__'
}

async function run(userId, fn) {
  const key = _getQueueKey(userId)
  const current = queues.get(key) || Promise.resolve()

  const next = current.then(() => fn()).catch((err) => {
    console.error('[commandQueue] task error:', err?.message || err)
    throw err
  })

  queues.set(key, next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  }))

  return next
}

module.exports = { run }
