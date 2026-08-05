'use strict'

const { createClient } = require('redis')

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_URI || ''
const REDIS_CACHE_TTL = parseInt(process.env.REDIS_CACHE_TTL || '30', 10)
let _client = null
let _connecting = null
let _redisErrorLogged = false

function isRedisEnabled() {
    return Boolean(REDIS_URL)
}

function formatRedisError(err) {
    if (!err) return 'Unknown Redis error'
    if (err instanceof AggregateError && Array.isArray(err.errors)) {
        return err.errors.map((sub) => sub?.message || String(sub)).join(' | ')
    }
    return err.message || String(err)
}

function handleRedisFailure(err) {
    _connecting = null
    const client = _client
    _client = null
    if (client && typeof client.disconnect === 'function') {
        void client.disconnect().catch(() => {})
    }
    if (!_redisErrorLogged) {
        console.warn('Redis unavailable, using in-memory cache until it reconnects:', formatRedisError(err))
        _redisErrorLogged = true
    }
}

async function getRedisClient() {
    if (!isRedisEnabled()) return null
    if (_client && _client.isOpen) return _client
    if (_connecting) return _connecting

    _connecting = (async () => {
        const client = createClient({
            url: REDIS_URL,
            socket: {
                reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 5000),
            },
        })

        client.on('error', (err) => {
            if (!err) return
            handleRedisFailure(err)
        })
        client.on('connect', () => {
            _redisErrorLogged = false
            console.log('Redis connected')
        })
        client.on('ready', () => {
            _redisErrorLogged = false
        })
        client.on('end', () => {
            if (_client === client) {
                _client = null
            }
        })
        client.on('reconnecting', () => {
            if (!_redisErrorLogged) {
                console.warn('Redis reconnecting in background...')
                _redisErrorLogged = true
            }
        })

        try {
            await client.connect()
            _client = client
            _connecting = null
            _redisErrorLogged = false
            return client
        } catch (err) {
            _connecting = null
            handleRedisFailure(err)
            return null
        }
    })()

    return _connecting
}

async function connectRedis() {
    if (!isRedisEnabled()) return null
    return getRedisClient()
}

async function redisGet(key) {
    try {
        const client = await getRedisClient()
        if (!client) return null
        const value = await client.get(key)
        return value != null ? JSON.parse(value) : null
    } catch (err) {
        if (!_redisErrorLogged) {
            console.error('Redis get failed:', err?.message || err)
            _redisErrorLogged = true
        }
        return null
    }
}

async function redisSet(key, value, ttlSec = REDIS_CACHE_TTL) {
    try {
        const client = await getRedisClient()
        if (!client) return false
        const payload = JSON.stringify(value)
        if (ttlSec > 0) {
            await client.set(key, payload, { EX: ttlSec })
        } else {
            await client.set(key, payload)
        }
        return true
    } catch (err) {
        if (!_redisErrorLogged) {
            console.error('Redis set failed:', err?.message || err)
            _redisErrorLogged = true
        }
        return false
    }
}

async function redisDel(key) {
    try {
        const client = await getRedisClient()
        if (!client) return false
        await client.del(key)
        return true
    } catch (err) {
        if (!_redisErrorLogged) {
            console.error('Redis del failed:', err?.message || err)
            _redisErrorLogged = true
        }
        return false
    }
}

async function redisDelPattern(pattern) {
    try {
        const client = await getRedisClient()
        if (!client) return false

        let cursor = '0'
        do {
            const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', '100')
            cursor = nextCursor
            if (Array.isArray(keys) && keys.length > 0) {
                await client.del(...keys)
            }
        } while (cursor !== '0')
        return true
    } catch (err) {
        if (!_redisErrorLogged) {
            console.error('Redis scan/delete failed:', err?.message || err)
            _redisErrorLogged = true
        }
        return false
    }
}

module.exports = {
    connectRedis,
    isRedisEnabled,
    redisGet,
    redisSet,
    redisDel,
    redisDelPattern,
}
