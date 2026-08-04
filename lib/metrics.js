const metrics = {
  commandsProcessed: 0,
  privateCommands: 0,
  groupCommands: 0,
  errors: 0,
  lastCommandAt: null,
}

function increment(name) {
  if (metrics[name] !== undefined) metrics[name] += 1
}

function recordMetric(name) {
  increment(name)
  metrics.lastCommandAt = Date.now()
}

function recordCacheAccess(name) {
  // simple stub for cache access diagnostics
  return true
}

function report() {
  return { ...metrics }
}

module.exports = { metrics, increment, report, recordMetric, recordCacheAccess }
