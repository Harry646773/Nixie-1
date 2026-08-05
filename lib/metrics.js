'use strict'

const fs = require('fs')
const path = require('path')

const metricsFile = process.env.METRICS_FILE || path.join(__dirname, '..', 'data', 'metrics.json')
const metricsState = { counters: {}, cache: {} }

function _ensureDir() {
    try {
        fs.mkdirSync(path.dirname(metricsFile), { recursive: true })
    } catch {}
}

function _load() {
    try {
        if (!fs.existsSync(metricsFile)) return metricsState
        const parsed = JSON.parse(fs.readFileSync(metricsFile, 'utf8'))
        if (parsed && typeof parsed === 'object') {
            metricsState.counters = parsed.counters || {}
            metricsState.cache = parsed.cache || {}
        }
    } catch {}
    return metricsState
}

function _save() {
    try {
        _ensureDir()
        fs.writeFileSync(metricsFile, JSON.stringify(metricsState, null, 2))
    } catch {}
}

function recordMetric(name, value = 1) {
    if (!name) return
    _load()
    metricsState.counters[name] = (metricsState.counters[name] || 0) + Number(value || 0)
    _save()
}

function recordCacheAccess(key, hit = false) {
    if (!key) return
    _load()
    metricsState.cache[key] = metricsState.cache[key] || { hits: 0, misses: 0 }
    if (hit) metricsState.cache[key].hits += 1
    else metricsState.cache[key].misses += 1
    _save()
}

module.exports = {
    recordMetric,
    recordCacheAccess,
}
