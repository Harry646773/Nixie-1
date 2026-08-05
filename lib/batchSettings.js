// lib/batchSettings.js
// Batches ALL per-message settings into a single MongoDB document read.
// This eliminates 10+ sequential DB/cache lookups per message.
'use strict'

const DB = require('./mongoData')
const { redisGet, redisSet, redisDelPattern, isRedisEnabled } = require('./redisClient')
const staticSettings = require('../settings')
const { fontExists } = require('./uiStyles')
const settingsManager = require('./settingsManager')

function cleanJid(jid = '') {
    return String(jid).replace(/:\d+(?=@)/, '').replace(/@s\.whatsapp\.net$/, '').replace(/^\+/, '')
}

const SETTINGS_CACHE_TTL = 60_000 // 60 seconds — cache settings for production performance

// In-memory cache for batch settings
const _batchCache = new Map()

settingsManager.events.on('userSettingsChanged', (userId) => {
    for (const key of _batchCache.keys()) {
        if (key.endsWith(`::${userId}`)) _batchCache.delete(key)
    }
})
settingsManager.events.on('groupSettingsChanged', (groupId) => {
    for (const key of _batchCache.keys()) {
        if (key.includes(`::${groupId}::`)) _batchCache.delete(key)
    }
})

async function _getCached(key) {
    const e = _batchCache.get(key)
    if (e) {
        if (Date.now() > e.exp) { _batchCache.delete(key); return null }
        return e.value
    }
    if (isRedisEnabled()) {
        const value = await redisGet(key)
        if (value !== null && value !== undefined) {
            _batchCache.set(key, { value, exp: Date.now() + SETTINGS_CACHE_TTL })
            return value
        }
    }
    return null
}
async function _setCached(key, value, ttl = SETTINGS_CACHE_TTL) {
    _batchCache.set(key, { value, exp: Date.now() + ttl })
    if (isRedisEnabled()) {
        await redisSet(key, value, Math.ceil(ttl / 1000))
    }
}

/**
 * Load ALL per-message settings for a bot + group + user in ONE operation.
 * Returns an object with everything the message handler needs.
 */
async function loadMessageSettings(botNum, chatId, senderId, isGroup) {
    const cleanSenderId = cleanJid(senderId)
    const cacheKey = `msgSettings::${botNum}::${chatId}::${cleanSenderId}`
    const cached = await _getCached(cacheKey)
    if (cached) return cached

    // OPTIMIZATION: Single MongoDB query with aggregation pipeline
    // This replaces 11 separate queries with 1 fast aggregation
    const db = await DB.getDb()
    const pipeline = [
        {
            $match: {
                $or: [
                    { type: 'botState', scope: botNum },
                    { type: 'mode', scope: botNum },
                    { type: 'owners', scope: 'global' },
                    { type: 'banned', scope: 'global' },
                    { type: 'pmBlocker', scope: botNum },
                    { type: 'autoreply', scope: botNum },
                    { type: 'mentionReply', scope: botNum },
                    { type: 'antidelete', scope: 'global' },
                    { type: 'antisticker', scope: 'global' },
                ]
            }
        },
        {
            $group: {
                _id: null,
                botState: { $first: { $cond: [{ $eq: ['$type', 'botState'] }, '$data', null] } },
                mode: { $first: { $cond: [{ $eq: ['$type', 'mode'] }, '$data', null] } },
                owners: { $first: { $cond: [{ $eq: ['$type', 'owners'] }, '$data', null] } },
                banned: { $first: { $cond: [{ $eq: ['$type', 'banned'] }, '$data', null] } },
                pmBlocker: { $first: { $cond: [{ $eq: ['$type', 'pmBlocker'] }, '$data', null] } },
                autoreply: { $first: { $cond: [{ $eq: ['$type', 'autoreply'] }, '$data', null] } },
                mentionReply: { $first: { $cond: [{ $eq: ['$type', 'mentionReply'] }, '$data', null] } },
                antidelete: { $first: { $cond: [{ $eq: ['$type', 'antidelete'] }, '$data', null] } },
                antisticker: { $first: { $cond: [{ $eq: ['$type', 'antisticker'] }, '$data', null] } },
            }
        }
    ]

    const [result, featureDocs] = await Promise.all([
        db.collection('bot_data').aggregate(pipeline).toArray(),
        db.collection('bot_data').find({ type: 'feature', scope: { $in: ['antispam', 'antisticker'] } }).toArray(),
    ])
    const data = result[0] || {}
    const features = Object.fromEntries(featureDocs.map(doc => [doc.scope, doc.data] ))
    
    // Fetch group settings and user settings in parallel for better performance
    let groupSettings = {}
    let userSettings = {}
    let moderators = []

    if (isGroup) {
        const [groupDoc, userDoc, groupMods] = await Promise.all([
            settingsManager.getGroupSettings(chatId),
            settingsManager.getUserSettings(cleanSenderId),
            DB.getMods(chatId),
        ])
        groupSettings = groupDoc || {}
        userSettings = userDoc || {}
        moderators = groupMods || []
    } else {
        userSettings = await settingsManager.getUserSettings(cleanSenderId)
    }

    // Default values for missing data
    const defaultPrefix = '.'
    const groupPrefix = typeof groupSettings?.prefix === 'string' ? groupSettings.prefix : undefined
    const userPrefix = typeof userSettings?.prefix === 'string' ? userSettings.prefix : defaultPrefix
    const effectivePrefix = isGroup ? (groupPrefix ?? userPrefix) : userPrefix

    const owners = Array.isArray(data.owners) ? data.owners.filter(Boolean) : []
    if (staticSettings.ownerNumber && !owners.some(o => cleanJid(o) === cleanJid(staticSettings.ownerNumber))) {
        owners.unshift(staticSettings.ownerNumber)
    }

    const settings = {
        botState: data.botState || { isOn: true },
        isPublic: data.mode?.isPublic !== false, // Default to public
        owners,
        ownerNumber: cleanJid(owners[0] || staticSettings.ownerNumber),
        ownerName: staticSettings.author || 'Admin',
        botName: staticSettings.botName || 'NIXIE',
        banned: data.banned || [],
        pmBlocker: data.pmBlocker || { enabled: false, message: '🚫 PMs are disabled.' },
        antidelete: data.antidelete || { enabled: false },
        antisticker: data.antisticker || { enabled: false },
        // Group-specific
        antilink: groupSettings?.antilink || { enabled: false, action: 'delete' },
        antibadword: groupSettings?.antibadword || { enabled: false, words: [] },
        mutedUsers: groupSettings?.mutedUsers || [],
        isWelcomeOn: !!groupSettings?.welcome,
        isGoodbyeOn: !!groupSettings?.goodbye,
        isChatbotOn: !!groupSettings?.chatbotEnabled,
        mods: moderators,
        // User-specific
        autoread: userSettings?.autoread || false,
        autoreact: userSettings?.autoreact || false,
        autotyping: userSettings?.autotyping || false,
        userPrefix: effectivePrefix,
        userMode: ['strict', 'smart', 'ai'].includes(String(userSettings?.mode || '').toLowerCase())
            ? String(userSettings.mode).toLowerCase()
            : 'strict',
        font: isGroup
            ? (typeof groupSettings?.font === 'string' && fontExists(groupSettings.font)
                ? groupSettings.font
                : (typeof userSettings?.font === 'string' && fontExists(userSettings.font)
                    ? userSettings.font
                    : 'regular'))
            : (typeof userSettings?.font === 'string' && fontExists(userSettings.font) ? userSettings.font : 'regular'),
        language: isGroup ? (groupSettings?.language || userSettings?.language || 'en') : (userSettings?.language || 'en'),
        replyStyle: isGroup ? (groupSettings?.replyStyle || userSettings?.replyStyle || 'premium') : (userSettings?.replyStyle || 'premium'),
        menuStyle: isGroup ? (groupSettings?.menuStyle || userSettings?.menuStyle || 'default') : (userSettings?.menuStyle || 'default'),
        theme: isGroup ? (groupSettings?.theme || userSettings?.theme || 'default') : (userSettings?.theme || 'default'),
        // Bot-wide features
        autoreply: data.autoreply || { enabled: false, replies: {} },
        mentionReply: data.mentionReply || { enabled: false, message: '' },
        antispam: features.antispam || { enabled: false },
        antisticker: features.antisticker || { enabled: false },
    }

    await _setCached(cacheKey, settings)
    return settings
}

// Invalidate batch cache for a user (call after settings change)
function invalidateUserCache(chatId, senderId) {
    const cleanSenderId = cleanJid(senderId)
    for (const key of _batchCache.keys()) {
        if (key.endsWith(`::${cleanSenderId}`)) {
            _batchCache.delete(key)
        }
    }
}

module.exports = { loadMessageSettings, invalidateUserCache }