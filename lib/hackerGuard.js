// ════════════════════════════════════════════════════════════
// 🔐 HACKER GUARD v2 - ADVANCED WHATSAPP BOT SECURITY SYSTEM
// ════════════════════════════════════════════════════════════

const _userViolations = new Map() // { userId: { warnings: 0, status: '', strikes: 0, timestamp: 0 } }
const _globalViolations = new Map() // { userId: { warnings: 0 } } - global warnings across groups
const _groupSettings = new Map()  // { groupId: { antiBot: false, antiDelete: false, antiSticker: false, antiBadword: false, antiGroupStatus: false, actions: { antiLink: 'warn' } } }
const _deletedMessages = new Map() // { groupId: [{ from, text, time }] } - store for anti-delete
const _stickerTimestamps = new Map() // { `${groupId}:${userId}`: { last: ts, count } }
const _messageTimestamps = new Map() // { `${groupId}:${userId}`: [ts,...] }
const _autoReplies = new Map() // per-user or per-group auto replies

// Use centralized DB for persistent group settings when available
let DB = null
try { DB = require('./mongoData') } catch (e) { DB = null }

// ── LOGGER ──────────────────────────────────────────────────
function logAction(feature, action, user, details = '') {
    const box = `╭━━〔 🔐 HACKER GUARD LOG 〕━━⬣
┃ Feature: ${feature}
┃ Action: ${action}
┃ User: ${user}
┃ ${details}
╰━━━━━━━━━━━━⬣`
    console.log(box)
}

// ── ACTION SYSTEM ───────────────────────────────────────────

async function warnUser(sock, groupId, userId, reason = 'Violation detected', opts = { global: false }) {
    try {
        if (opts.global) {
            const gcur = _globalViolations.get(userId) || { warnings: 0 }
            gcur.warnings = (gcur.warnings || 0) + 1
            _globalViolations.set(userId, gcur)
            const userName = userId.split('@')[0]
            const msg = `⚠️ *GLOBAL WARNING* ⚠️\n\n@${userName}\nReason: ${reason}\nGlobal Warnings: ${gcur.warnings}/3`
            for (const owner of (require('../data/owner.json') || [])) {
                try { await sock.sendMessage(owner + '@s.whatsapp.net', { text: msg, mentions: [userId] }).catch(() => {}) } catch {}
            }
            logAction('System', 'GLOBAL_WARN', userName, `Warnings: ${gcur.warnings}/3`)
            return gcur.warnings
        }

        const key = `${groupId}:${userId}`
        const current = _userViolations.get(key) || { warnings: 0, status: '', strikes: 0, timestamp: Date.now() }
        current.warnings = (current.warnings || 0) + 1
        current.timestamp = Date.now()
        _userViolations.set(key, current)

        const userName = userId.split('@')[0]
        await sock.sendMessage(groupId, {
            text: `⚠️ *WARNING* ⚠️\n\n@${userName}\nReason: ${reason}\nWarnings: ${current.warnings}/3`,
            mentions: [userId]
        }).catch(() => {})

        logAction('System', 'WARN', userName, `Warnings: ${current.warnings}/3`)
        return current.warnings
    } catch (e) {
        console.error('[hackerGuard] warnUser error:', e.message)
        return 0
    }
}

async function setUserStatus(groupId, userId, status) {
    try {
        const key = `${groupId}:${userId}`
        const current = _userViolations.get(key) || { warnings: 0, status: '', strikes: 0, timestamp: Date.now() }
        current.status = status
        _userViolations.set(key, current)

        const userName = userId.split('@')[0]
        logAction('System', 'SET', userName, `Status: ${status}`)
    } catch (e) {
        console.error('[hackerGuard] setUserStatus error:', e.message)
    }
}

async function kickUser(sock, groupId, userId) {
    try {
        const { isBotAdmin } = await checkAdmin(sock, groupId)
        if (!isBotAdmin) return false

        const userName = userId.split('@')[0]
        await sock.groupParticipantsUpdate(groupId, [userId], 'remove')
        await sock.sendMessage(groupId, {
            text: `🚫 @${userName} has been removed from the group.`,
            mentions: [userId]
        }).catch(() => {})

        logAction('System', 'KICK', userName, 'Removed from group')
        _userViolations.delete(`${groupId}:${userId}`)
        return true
    } catch (e) {
        console.error('[hackerGuard] kickUser error:', e.message)
        return false
    }
}

// ── HELPER: Check Admin ─────────────────────────────────────
async function checkAdmin(sock, groupId) {
    try {
        const meta = await sock.groupMetadata(groupId)
        const botId = sock.user?.id || sock.user?.lid
        const botJid = botId?.includes('@') ? botId : `${botId}@s.whatsapp.net`
        const botAdmin = meta.participants.some(p => p.id === botJid && (p.admin === 'admin' || p.admin === 'superadmin'))
        return { isBotAdmin: botAdmin, meta }
    } catch (e) {
        console.error('[hackerGuard] checkAdmin error:', e.message)
        return { isBotAdmin: false, meta: null }
    }
}

// ════════════════════════════════════════════════════════════
// FEATURE: ANTI BOT
// ════════════════════════════════════════════════════════════
async function handleAntiBot(sock, update, groupId, senderJid) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antibot')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        if (!groupSettings?.antiBot) return

        const isSuspiciousBot = /bot|auto|script|robot/i.test(senderJid)
        if (!isSuspiciousBot) return

        // Apply global warnings. After 3 global warnings -> attempt kick if configured
        const globalCount = await warnUser(sock, groupId, senderJid, 'Suspicious bot account detected', { global: true })
        if (globalCount >= 3) {
            // Only kick from groups where bot is admin and group configured to kick
            const action = (groupSettings.action && groupSettings.action.antibot) || 'kick'
            if (action === 'kick') {
                await kickUser(sock, groupId, senderJid)
            }
        }

        logAction('AntiBot', 'DETECTED', senderJid.split('@')[0], `GlobalWarnings:${globalCount}`)
    } catch (e) {
        console.error('[hackerGuard] antiBot error:', e.message)
    }
}

// ════════════════════════════════════════════════════════════
// FEATURE: ANTI DELETE
// ════════════════════════════════════════════════════════════
async function storeMessageForGuard(groupId, message) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antidelete')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        if (!groupSettings?.antiDelete) return

        if (!_deletedMessages.has(groupId)) {
            _deletedMessages.set(groupId, [])
        }

        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '[media]'
        const sender = message.key.participant || message.key.remoteJid
        _deletedMessages.get(groupId).push({
            from: sender,
            text,
            id: message.key.id,
            timestamp: Date.now()
        })

        // Keep only last 100 messages per group
        const stored = _deletedMessages.get(groupId)
        if (stored.length > 100) {
            stored.shift()
        }
    } catch (e) {
        console.error('[hackerGuard] storeMessageForGuard error:', e.message)
    }
}

async function handleAntiDelete(sock, groupId, deletedKey) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antidelete')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        if (!groupSettings?.antiDelete) return

        const stored = _deletedMessages.get(groupId) || []
        const found = stored.find(m => m.id === deletedKey?.id)

        if (found) {
            const sender = found.from.split('@')[0]
            await sock.sendMessage(groupId, {
                text: `🔁 *REVOKED MESSAGE*\n\nFrom: @${sender}\nContent: ${found.text}`,
                mentions: [found.from]
            }).catch(() => {})

            logAction('AntiDelete', 'RESTORE', sender, `Message: ${found.text.slice(0, 30)}...`)
        }
    } catch (e) {
        console.error('[hackerGuard] antiDelete error:', e.message)
    }
}

// ════════════════════════════════════════════════════════════
// FEATURE: ANTI STICKER
// ════════════════════════════════════════════════════════════
function findStickerMessagePayload(obj) {
    if (!obj) return null
    if (obj.stickerMessage) return obj.stickerMessage
    if (obj.ephemeralMessage?.message) return findStickerMessagePayload(obj.ephemeralMessage.message)
    if (obj.viewOnceMessage?.message) return findStickerMessagePayload(obj.viewOnceMessage.message)
    if (obj.viewOnceMessageV2?.message) return findStickerMessagePayload(obj.viewOnceMessageV2.message)
    return null
}

async function handleAntiSticker(sock, groupId, senderJid, message) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antisticker')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        const groupSettingsSafe = groupSettings || {}
        if (!groupSettingsSafe.enabled && !groupSettingsSafe.antiSticker) return

        const sticker = findStickerMessagePayload(message?.message)
        if (!sticker) return

        const key = `${groupId}:${senderJid}`
        const tsEntry = _stickerTimestamps.get(key) || { last: 0, count: 0 }
        const now = Date.now()
        const delta = now - (tsEntry.last || 0)

        // If stickers are sent very quickly (under 500ms), increase count
        if (delta < 500) {
            tsEntry.count = (tsEntry.count || 0) + 1
        } else {
            tsEntry.count = 1
        }
        tsEntry.last = now
        _stickerTimestamps.set(key, tsEntry)

        const count = tsEntry.count
        const senderName = senderJid.split('@')[0]

        // apply action based on config
        const action = typeof groupSettingsSafe.action === 'string'
            ? groupSettingsSafe.action
            : groupSettingsSafe.action?.antisticker || 'warn'
        if (count === 1) {
            if (action === 'warn' || action === 'delete') await warnUser(sock, groupId, senderJid, 'Sticker not allowed (fast)')
        } else if (count === 2) {
            if (action === 'warn' || action === 'delete') await warnUser(sock, groupId, senderJid, 'Sticker not allowed (repeat)')
            await setUserStatus(groupId, senderJid, 'sticker_offender')
        } else if (count >= 3) {
            await kickUser(sock, groupId, senderJid)
        }

        // delete sticker if bot is admin and action includes delete
        try {
            if (groupSettingsSafe.action && groupSettingsSafe.action.antisticker === 'delete') {
                if (message?.key) await sock.sendMessage(groupId, { delete: message.key }).catch(() => {})
            }
        } catch {}

        logAction('AntiSticker', `COUNT_${count}`, senderName, `Strikes: ${count}/3`)
    } catch (e) {
        console.error('[hackerGuard] antiSticker error:', e.message)
    }
}

// ════════════════════════════════════════════════════════════
// FEATURE: ANTI BADWORD
// ════════════════════════════════════════════════════════════
const BADWORDS = [
    'badword1', 'badword2', 'badword3', // Add your words
    'curse', 'inappropriate'
]

function containsBadword(text) {
    const lower = (text || '').toLowerCase()
    return BADWORDS.some(word => lower.includes(word))
}

function containsLink(text) {
    if (!text) return false
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(\S+\.com\S*)|(\S+\.net\S*)/i
    return urlRegex.test(text)
}

async function handleAntiBadword(sock, groupId, senderJid, text) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antibadword')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        const groupSettingsSafe = groupSettings || {}
        if (!groupSettingsSafe.enabled && !groupSettingsSafe.antiBadword) return
        if (!text || !containsBadword(text)) return

        const key = `${groupId}:${senderJid}`
        const current = _userViolations.get(key) || { warnings: 0, status: '', strikes: 0, timestamp: Date.now() }

        const strikes = (current.strikes || 0) + 1
        current.strikes = strikes
        current.status = 'badword_strike'
        _userViolations.set(key, current)

        const senderName = senderJid.split('@')[0]

        const action = (groupSettingsSafe.action && groupSettingsSafe.action.antibadword) || 'warn'
        if (strikes === 1) {
            await warnUser(sock, groupId, senderJid, `Inappropriate language (${strikes}/3)`)
        } else if (strikes === 2) {
            await warnUser(sock, groupId, senderJid, `Inappropriate language (${strikes}/3)`)
        } else if (strikes >= 3) {
            if (action === 'kick') await kickUser(sock, groupId, senderJid)
            else await kickUser(sock, groupId, senderJid)
        }

        logAction('AntiBadword', `STRIKE_${strikes}`, senderName, `Strikes: ${strikes}/3`)
    } catch (e) {
        console.error('[hackerGuard] antiBadword error:', e.message)
    }
}

// ════════════════════════════════════════════════════════════
// FEATURE: ANTI GROUP STATUS
// ════════════════════════════════════════════════════════════
async function handleAntiGroupStatus(sock, groupId, action, actor) {
    try {
        const groupSettings = _groupSettings.get(groupId) || {}
        if (!groupSettings.antiGroupStatus || !actor) return

        const { isBotAdmin } = await checkAdmin(sock, groupId)
        if (!isBotAdmin) return

        const actorName = actor.split('@')[0]
        await warnUser(sock, groupId, actor, `Attempted to ${action} group settings`)
        logAction('AntiGroupStatus', action.toUpperCase(), actorName, 'Group modification attempt')
    } catch (e) {
        console.error('[hackerGuard] antiGroupStatus error:', e.message)
    }
}

// ── FEATURE: ANTI-LINK
async function handleAntiLink(sock, groupId, senderJid, text, message) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antilink')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        const groupSettingsSafe = groupSettings || {}
        if (!groupSettingsSafe.enabled && !groupSettingsSafe.antiLink) return
        if (!text || !containsLink(text)) return

        const key = `${groupId}:${senderJid}`
        const current = _userViolations.get(key) || { warnings: 0, status: '', strikes: 0, timestamp: Date.now() }
        current.strikes = (current.strikes || 0) + 1
        _userViolations.set(key, current)

        const action = (groupSettingsSafe.action && groupSettingsSafe.action.antilink) || 'warn'
        if (action === 'delete') {
            try { if (message?.key) await sock.sendMessage(groupId, { delete: message.key }).catch(() => {}) } catch {}
        }

        if (current.strikes === 1) {
            await warnUser(sock, groupId, senderJid, 'links not allowed')
        } else if (current.strikes === 2) {
            await warnUser(sock, groupId, senderJid, 'links not allowed')
        } else if (current.strikes >= 3) {
            if (action === 'kick') await kickUser(sock, groupId, senderJid)
            else await kickUser(sock, groupId, senderJid)
        }

        logAction('AntiLink', `STRIKE_${current.strikes}`, senderJid.split('@')[0], `Link detected`)
    } catch (e) {
        console.error('[hackerGuard] antiLink error:', e.message)
    }
}

// ── FEATURE: ANTI-SPAM (basic)
async function handleAntiSpam(sock, groupId, senderJid, text) {
    try {
        let groupSettings = _groupSettings.get(groupId)
        if (!groupSettings && DB) {
            const cfg = await DB.getGroupSetting(groupId, 'antispam')
            groupSettings = cfg || {}
            _groupSettings.set(groupId, groupSettings)
        }
        const groupSettingsSafe = groupSettings || {}
        if (!groupSettingsSafe.enabled && !groupSettingsSafe.antiSpam) return

        const key = `${groupId}:${senderJid}`
        if (!_messageTimestamps.has(key)) _messageTimestamps.set(key, [])
        const arr = _messageTimestamps.get(key)
        const now = Date.now()
        arr.push(now)
        // keep only last 10 timestamps
        while (arr.length > 10) arr.shift()

        // If 3 messages within 5 seconds -> warn
        const recent = arr.filter(t => now - t <= 5000)
        if (recent.length >= 3) {
            await warnUser(sock, groupId, senderJid, 'Spamming messages')
            logAction('AntiSpam', 'WARNED', senderJid.split('@')[0], `Recent: ${recent.length}`)
            // clear timestamps to avoid repeat spam loops
            _messageTimestamps.set(key, [])
        }
    } catch (e) {
        console.error('[hackerGuard] antiSpam error:', e.message)
    }
}

// ════════════════════════════════════════════════════════════
// COMMANDS: TOGGLE FEATURES
// ════════════════════════════════════════════════════════════
async function toggleFeature(groupId, feature, enable) {
    try {
        if (!_groupSettings.has(groupId)) {
            _groupSettings.set(groupId, {})
        }
        const settings = _groupSettings.get(groupId)
        settings[feature] = enable

        const status = enable ? '✅ ON' : '❌ OFF'
        // Persist change in DB if available
        try { if (DB && typeof DB.setGroupSetting === 'function') await DB.setGroupSetting(groupId, feature, { enabled: !!enable }) } catch (e) { console.error('[hackerGuard] toggleFeature persist failed:', e?.message || e) }
        return `${feature}: ${status}`
    } catch (e) {
        console.error('[hackerGuard] toggleFeature error:', e.message)
        return null
    }
}

async function setFeatureAction(groupId, feature, action) {
    try {
        if (!_groupSettings.has(groupId)) _groupSettings.set(groupId, {})
        const s = _groupSettings.get(groupId)
        if (!s.action) s.action = {}
        s.action[feature] = action
        try { if (DB && typeof DB.setGroupSetting === 'function') await DB.setGroupSetting(groupId, `${feature}_action`, { action }) } catch (e) { console.error('[hackerGuard] setFeatureAction persist failed:', e?.message || e) }
        return true
    } catch (e) {
        console.error('[hackerGuard] setFeatureAction error:', e.message)
        return false
    }
}

async function setAutoReply(targetId, message) {
    try {
        _autoReplies.set(targetId, message)
        return true
    } catch (e) {
        return false
    }
}

async function getAutoReply(targetId) {
    return _autoReplies.get(targetId) || null
}

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════
module.exports = {
    handleAntiBot,
    handleAntiDelete,
    handleAntiSticker,
    handleAntiBadword,
    handleAntiGroupStatus,
    handleAntiLink,
    handleAntiSpam,
    toggleFeature,
    setFeatureAction,
    storeMessageForGuard,
    warnUser,
    setUserStatus,
    kickUser,
    setAutoReply,
    getAutoReply,
    logAction,
    checkAdmin
}
