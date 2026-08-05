// ════════════════════════════════════════════════════════════════════
// CACHE MANAGER - In-Memory Cache with TTL Support
// ════════════════════════════════════════════════════════════════════

class CacheEntry {
  constructor(data, ttl) {
    this.data = data
    this.createdAt = Date.now()
    this.expiresAt = Date.now() + ttl
  }

  isExpired() {
    return Date.now() > this.expiresAt
  }

  getAge() {
    return Date.now() - this.createdAt
  }
}

class CacheManager {
  constructor() {
    this.cache = new Map()
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      expirations: 0
    }
  }

  set(key, data, ttlMs = 300000) {
    if (!key || !data) return false

    this.cache.set(key, new CacheEntry(data, ttlMs))
    this.stats.sets++
    return true
  }

  get(key) {
    if (!key) return null

    const entry = this.cache.get(key)
    if (!entry) {
      this.stats.misses++
      return null
    }

    if (entry.isExpired()) {
      this.cache.delete(key)
      this.stats.expirations++
      this.stats.misses++
      return null
    }

    this.stats.hits++
    return entry.data
  }

  has(key) {
    return this.get(key) !== null
  }

  delete(key) {
    if (this.cache.has(key)) {
      this.cache.delete(key)
      this.stats.deletes++
      return true
    }
    return false
  }

  clear() {
    this.cache.clear()
  }

  // Cache search results with longer TTL (5-10 minutes)
  setSearch(query, results) {
    return this.set(`search:${query}`, results, 600000) // 10 minutes
  }

  getSearch(query) {
    return this.get(`search:${query}`)
  }

  // Cache download metadata with shorter TTL (2-5 minutes)
  setDownloadMeta(url, meta) {
    return this.set(`meta:${url}`, meta, 300000) // 5 minutes
  }

  getDownloadMeta(url) {
    return this.get(`meta:${url}`)
  }

  // Cache buffer data with TTL (1-2 minutes for memory efficiency)
  setBuffer(key, buffer) {
    return this.set(`buffer:${key}`, buffer, 120000) // 2 minutes
  }

  getBuffer(key) {
    return this.get(`buffer:${key}`)
  }

  // Batch get
  mget(keys) {
    const result = {}
    for (const key of keys) {
      result[key] = this.get(key)
    }
    return result
  }

  // Batch set
  mset(data, ttlMs = 300000) {
    for (const [key, value] of Object.entries(data)) {
      this.set(key, value, ttlMs)
    }
  }

  // Cleanup expired entries
  prune() {
    let pruned = 0
    for (const [key, entry] of this.cache.entries()) {
      if (entry.isExpired()) {
        this.cache.delete(key)
        pruned++
        this.stats.expirations++
      }
    }
    return pruned
  }

  // Get statistics
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0

    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: `${hitRate}%`,
      memoryEstimate: `${(this.cache.size * 4).toFixed(2)}KB` // Rough estimate
    }
  }

  // Get cache size in entries
  size() {
    return this.cache.size
  }

  // Set all entries TTL (useful for global cleanup)
  setGlobalTTL(ttlMs) {
    for (const entry of this.cache.values()) {
      entry.expiresAt = Date.now() + ttlMs
    }
  }

  // Periodic pruning
  startPruningInterval(intervalMs = 60000) {
    this._pruneInterval = setInterval(() => {
      const pruned = this.prune()
      if (pruned > 0) {
        console.log(`[cacheManager] Pruned ${pruned} expired entries`)
      }
    }, intervalMs)
  }

  stopPruningInterval() {
    if (this._pruneInterval) {
      clearInterval(this._pruneInterval)
    }
  }

  // Pattern-based delete
  deletePattern(pattern) {
    let deleted = 0
    for (const [key] of this.cache.entries()) {
      if (key.includes(pattern)) {
        this.cache.delete(key)
        deleted++
        this.stats.deletes++
      }
    }
    return deleted
  }

  // Get all entries (for debugging)
  getAll() {
    const result = {}
    for (const [key, entry] of this.cache.entries()) {
      result[key] = {
        data: entry.data,
        age: entry.getAge(),
        expiresIn: Math.max(0, entry.expiresAt - Date.now()),
        isExpired: entry.isExpired()
      }
    }
    return result
  }
}

const cacheManager = new CacheManager()
cacheManager.startPruningInterval(60000) // Prune every minute

module.exports = {
  cacheManager,
  CacheManager,
  CacheEntry
}
