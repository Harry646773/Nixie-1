// @ts-nocheck
'use strict'

const fs      = require('fs')
const path    = require('path')
const axios   = require('axios')
const mongoose = require('mongoose')
const settings = require('./settings')
const { PREFIXES } = require('./config')
const fetch   = globalThis.fetch || require('node-fetch')
const yts     = require('yt-search')
const store   = require('./lib/lightweight_store')

// ── MongoDB data layer (replaces ALL json file read/write) ────
const DB = require('./lib/mongoData')
const Permission = require('./lib/permissionManager')
const TicTacToe = require('./lib/ticTacToe')
const { animateMessage } = require('./lib/animationEngine')

// ── Per-user command queue ────────────────────────────────────
const queue = require('./lib/commandQueue')

// ── Batch settings loader (optimized settings loading) ────────
const { loadMessageSettings, invalidateUserCache } = require('./lib/batchSettings')

// ── Metrics tracking (for production monitoring) ────────────────
const { recordMetric, recordCacheAccess } = require('./lib/metrics')

// AI command handler (modular)
const aiCommand = require('./lib/aiCommand')
const imagineCommand = require('./lib/imagineCommand')

// ── Security system (HackerGuard) ───────────────────────────
const { handleAntiBot, handleAntiSticker, handleAntiBadword, handleAntiGroupStatus, handleAction, toggleFeature, storeMessageForGuard } = require('./lib/hackerGuard')
const { antistatusCommand, checkStatusForViolations, checkMessageForViolations } = require('./lib/antiStatus')

// ── Media Engine (Pro Max) ───────────────────────────────────
const { searchYouTube, downloadYTAudio, downloadYTVideo, fetchLyrics, fetchAudioForUser, fetchVideoForUser, sanitizeFileName, mediaStatus } = require('./lib/mediaEngine')
const playCommand = require('./lib/playCommand')
const videoCommand = require('./lib/videoCommand')
// ── View-once bypass command
const viewonceCommand = require('./lib/viewonceCommand')

// ── Textmaker (Text-to-Image) ────────────────────────────────
const { generateStyledText, getSupportedStyles } = require('./lib/textmaker')

// ── UI and style helpers ───────────────────────────────────
const { applyFont, listFonts, fontExists, previewFont } = require('./lib/uiStyles')

// ── Misc Engine (Utilities & Text Effects) ──────────────────
const { processMisc, getSupportedMiscTypes } = require('./lib/miscEngine')

// ── Anime Engine (Actions & Info) ──────────────────────────
const { processAnime, getSupportedAnimeTypes } = require('./lib/animeEngine')

// ── Baileys media helpers ─────────────────────────────────────
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { writeFile } = require('fs/promises')
const { tmpdir }    = require('os')

// ── Tmp dir for media ─────────────────────────────────────────
// Allow overriding tmp storage location via env when mounting extra storage
const TEMP_MEDIA_DIR = process.env.TEMP_MEDIA_DIR ? path.resolve(process.env.TEMP_MEDIA_DIR) : path.join(__dirname, 'tmp')
if (!fs.existsSync(TEMP_MEDIA_DIR)) fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true })

// ── Data dir (keep for legacy compat; no longer used for storage) ─
const dataDir = path.join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

// ── Axios defaults ────────────────────────────────────────────
const AXIOS_DEFAULTS = {
    timeout: 60_000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
    },
}

// ════════════════════════════════════════════════════════════
// ★ PERFORMANCE OPTIMIZATION INFRASTRUCTURE ★
// ════════════════════════════════════════════════════════════

// ── Per-user cooldowns (prevent rapid-fire commands) ─────────
const _userCooldowns = new Map()
const COOLDOWN_MS = 800 // Min ms between commands per user

function isUserOnCooldown(userId) {
    const now = Date.now()
    const lastRun = _userCooldowns.get(userId) || 0
    if (now - lastRun < COOLDOWN_MS) return true
    _userCooldowns.set(userId, now)
    return false
}

// Clean old cooldowns every 5 min
setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _userCooldowns) {
        if (now - v > 300_000) _userCooldowns.delete(k)
    }
}, 5 * 60_000).unref()

// ── Structured logging (no spammy console) ──────────────────
function logCmd(jid, cmd) {
    const num = jid.split('@')[0]
    const normalized = cmd.startsWith('.') ? cmd : `.${cmd}`
    console.log(`USER ${num}: ${normalized}`)
}

// ── Background task processor (fire-and-forget ops) ─────────
// Support per-user background queues so one user's heavy tasks don't block others.
const _bgTasksGlobal = []
const _bgTasksPerUser = new Map() // userId -> { tasks: [], processing: false }

const _groupMetadataCache = new Map()
const GROUP_METADATA_TTL = 30_000
function pruneGroupMetadataCache() {
    const now = Date.now()
    for (const [chatId, entry] of _groupMetadataCache) {
        if (entry.exp <= now) _groupMetadataCache.delete(chatId)
    }
}
setInterval(pruneGroupMetadataCache, GROUP_METADATA_TTL).unref()

async function getGroupMetadata(sock, chatId) {
    const now = Date.now()
    const existing = _groupMetadataCache.get(chatId)
    if (existing) {
        if (existing.promise) return existing.promise
        if (existing.exp > now) return existing.meta
    }

    const promise = sock.groupMetadata(chatId)
        .then((meta) => {
            _groupMetadataCache.set(chatId, { meta, exp: Date.now() + GROUP_METADATA_TTL })
            return meta
        })
        .catch((err) => {
            _groupMetadataCache.delete(chatId)
            throw err
        })

    _groupMetadataCache.set(chatId, { promise, exp: now + GROUP_METADATA_TTL })
    return promise
}

async function runInBackground(fn, userId = null) {
    return new Promise((resolve, reject) => {
        const taskWrapper = async () => {
            try {
                const result = await fn()
                resolve(result)
            } catch (err) {
                reject(err)
            }
        }

        if (userId) {
            if (!_bgTasksPerUser.has(userId)) _bgTasksPerUser.set(userId, { tasks: [], processing: false })
            const entry = _bgTasksPerUser.get(userId)
            entry.tasks.push(taskWrapper)
            if (!entry.processing) {
                entry.processing = true
                setImmediate(() => _processBgTasksForUser(userId))
            }
            return
        }

        _bgTasksGlobal.push(taskWrapper)
        if (_bgTasksGlobal.length === 1) setImmediate(() => _processBgTasksGlobal())
    })
}

async function _processBgTasksForUser(userId) {
    const entry = _bgTasksPerUser.get(userId)
    if (!entry) return
    while (entry.tasks.length > 0) {
        const task = entry.tasks.shift()
        try { await task().catch(() => {}) } catch {}
    }
    entry.processing = false
    // prune empty queues
    if (entry.tasks.length === 0) _bgTasksPerUser.delete(userId)
}

async function _processBgTasksGlobal() {
    while (_bgTasksGlobal.length > 0) {
        const task = _bgTasksGlobal.shift()
        try { await task().catch(() => {}) } catch {}
    }
}

// ── API response cache (30s TTL) ────────────────────────────
const _apiCache = new Map()
const API_CACHE_TTL = 30_000

function _getCachedApi(key) {
    const e = _apiCache.get(key)
    if (!e) return null
    if (Date.now() > e.exp) { _apiCache.delete(key); return null }
    return e.data
}

function _setCachedApi(key, data, ttl = API_CACHE_TTL) {
    _apiCache.set(key, { data, exp: Date.now() + ttl })
}

// Clean old API cache every 10 min
setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _apiCache) {
        if (now - v.exp > 0) _apiCache.delete(k)
    }
}, 10 * 60_000).unref()

// ── Image cache (for profile pics, etc) ─────────────────────
const _imageCache = new Map()
const IMAGE_CACHE_TTL = 300_000 // 5 min

// ── Batch anti-checks queue ────────────────────────────────
const _antiCheckBatch = new Map()

// ──────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────

if (!global.botStartTime) global.botStartTime = Date.now()
if (global.nixieOnline === undefined) global.nixieOnline = true

function formatUptime(ms) {
    const s = Math.floor((ms / 1000) % 60)
    const m = Math.floor((ms / 60_000) % 60)
    const h = Math.floor((ms / 3_600_000) % 24)
    const d = Math.floor(ms / 86_400_000)
    const parts = []
    if (d) parts.push(`${d}d`)
    if (h) parts.push(`${h}h`)
    if (m) parts.push(`${m}m`)
    if (s) parts.push(`${s}s`)
    return parts.join(' ') || '0s'
}

function hackerBox(text) {
    const lines   = text.split('\n')
    const maxLen  = Math.max(...lines.map(l => l.length))
    const border  = '-'.repeat(maxLen + 2)
    let out = `+${border}+\n`
    for (const line of lines) out += `| ${line.padEnd(maxLen)} |\n`
    out += `+${border}+`
    return out
}

function formatPresentationText(text, settings = {}) {
    if (typeof text !== 'string') return text
    if (settings?.font) return applyFont(text, settings.font)
    return text
}

function formatBotText(text, settings = {}) {
    if (typeof text !== 'string') return text
    if (settings?.font) return applyFont(text, settings.font)
    return text
}

async function sendStyledMessage(sock, chatId, content, options = {}, settings = {}) {
    if (typeof content === 'string') {
        content = { text: formatBotText(content, settings) }
    } else {
        // format known textual fields
        if (content?.text) content = { ...content, text: formatBotText(content.text, settings) }
        if (content?.caption) content = { ...content, caption: formatBotText(content.caption, settings) }
    }
    return sock.sendMessage(chatId, content, options).catch(() => null)
}

async function sendAnimatedText(sock, chatId, frames, quoted = null, delayMs = 300, settings = {}) {
    if (!Array.isArray(frames) || frames.length === 0) return null
    const formattedFrames = frames.map(frame => formatPresentationText(frame, settings))
    const animMsg = await animateMessage(sock, chatId, formattedFrames, delayMs, quoted)
    const finalText = typeof animMsg === 'string' && animMsg.trim() ? animMsg : formattedFrames[formattedFrames.length - 1]
    await sendStyledMessage(sock, chatId, { text: finalText }, quoted ? { quoted } : {}, settings).catch(() => {})
    return finalText
}

async function lookupLocation(query) {
    const res = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
        params: { name: query, count: 1, language: 'en', format: 'json' },
        timeout: 10_000,
    })
    const place = res.data?.results?.[0]
    if (!place) return null
    return {
        name: place.name,
        country: place.country,
        admin1: place.admin1,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
    }
}

function weatherCodeDescription(code) {
    const labels = {
        0: 'Clear skies',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Fog',
        48: 'Depositing rime fog',
        51: 'Light drizzle',
        53: 'Moderate drizzle',
        55: 'Dense drizzle',
        56: 'Light freezing drizzle',
        57: 'Dense freezing drizzle',
        61: 'Light rain',
        63: 'Moderate rain',
        65: 'Heavy rain',
        66: 'Light freezing rain',
        67: 'Heavy freezing rain',
        71: 'Light snow',
        73: 'Moderate snow',
        75: 'Heavy snow',
        77: 'Snow grains',
        80: 'Light showers',
        81: 'Moderate showers',
        82: 'Violent showers',
        85: 'Light snow showers',
        86: 'Heavy snow showers',
        95: 'Thunderstorm',
        96: 'Thunderstorm + hail',
        99: 'Severe thunderstorm',
    }
    return labels[code] || 'Unknown'
}

function premiumPanel(title, headerRows, bodyRows) {
    const allRows = [...headerRows, ...bodyRows]
    const width = Math.max(...allRows.map(r => r.length))
    const titleLabel = `〔 ${title} 〕`
    const padding = Math.max(0, width - titleLabel.length)
    const top = `┏━━━${titleLabel}${'━'.repeat(padding + 3)}┓`
    const separator = `┣${'━'.repeat(width + 2)}┫`
    const bottom = `┗${'━'.repeat(width + 2)}┛`
    const formatted = []
    for (const row of headerRows) formatted.push(`┃ ${row.padEnd(width)} ┃`)
    if (bodyRows.length) formatted.push(separator)
    for (const row of bodyRows) formatted.push(`┃ ${row.padEnd(width)} ┃`)
    return [top, ...formatted, bottom].join('\n')
}

function formatCalendarMonth(date = new Date()) {
    const year = date.getFullYear()
    const month = date.getMonth()
    const monthName = date.toLocaleString('en-US', { month: 'long' })
    const firstDay = new Date(year, month, 1).getDay()
    const days = new Date(year, month + 1, 0).getDate()
    const rows = []
    let line = ''
    for (let i = 0; i < firstDay; i++) line += '   '
    for (let day = 1; day <= days; day++) {
        line += String(day).padStart(2, ' ') + (day === days ? '' : ' ')
        if ((firstDay + day) % 7 === 0 || day === days) {
            rows.push(line.trimEnd())
            line = ''
        }
    }
    return { monthName, year, rows }
}

function getUserId(message) {
    return message?.key?.participant || message?.participant ||
        message?.message?.extendedTextMessage?.contextInfo?.participant ||
        message?.message?.imageMessage?.contextInfo?.participant ||
        message?.message?.videoMessage?.contextInfo?.participant ||
        message?.message?.documentMessage?.contextInfo?.participant ||
        message?.key?.remoteJid || ''
}

// Strip device suffix for comparison
function cleanJid(jid = '') {
    if (jid == null || jid === undefined || jid === '') return ''
    const value = String(jid)
    return value.replace(/:\d+(?=@)/, '').replace(/@s\.whatsapp\.net$/, '').replace(/^\+/, '')
}

function extractMessageText(message) {
    const effectiveMessage = getEffectiveMessage(message)
    if (!effectiveMessage) return ''

    return (
        effectiveMessage.conversation ||
        effectiveMessage.extendedTextMessage?.text ||
        effectiveMessage.imageMessage?.caption ||
        effectiveMessage.videoMessage?.caption ||
        effectiveMessage.documentMessage?.caption ||
        effectiveMessage.audioMessage?.caption ||
        ''
    ).trim()
}

// ── Admin check ───────────────────────────────────────────────
let _areJidsSameUser = null
async function getAreJidsSameUser() {
    if (!_areJidsSameUser) {
        const m = await import('@whiskeysockets/baileys')
        _areJidsSameUser = m.areJidsSameUser
    }
    return _areJidsSameUser
}

async function checkAdmin(sock, chatId, senderId) {
    try {
        const fn   = await getAreJidsSameUser()
        const meta = await getGroupMetadata(sock, chatId)
        const bot  = cleanJid(sock.user?.id || '')
        const botLid = cleanJid(sock.user?.lid || '')

        const isBotAdmin = meta.participants.some(p =>
            p.admin && (cleanJid(p.id) === bot || cleanJid(p.id) === botLid)
        )
        const isSenderAdmin = meta.participants.some(p =>
            p.admin && (cleanJid(p.id) === cleanJid(senderId))
        )
        return { isBotAdmin, isSenderAdmin }
    } catch {
        return { isBotAdmin: false, isSenderAdmin: false }
    }
}

// ── Rate limiter (per user, in-memory) ───────────────────────
const _rateLimits = new Map()
function isRateLimited(userId, maxReqs = 15, windowMs = 30_000) {
    const now  = Date.now()
    const reqs = (_rateLimits.get(userId) || []).filter(t => now - t < windowMs)
    if (reqs.length >= maxReqs) return true
    reqs.push(now)
    _rateLimits.set(userId, reqs)
    return false
}
setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _rateLimits) {
        const fresh = v.filter(t => now - t < 30_000)
        if (fresh.length === 0) _rateLimits.delete(k)
        else _rateLimits.set(k, fresh)
    }
}, 60_000).unref()

// ── Temp folder cleaner ───────────────────────────────────────
async function getTmpSizeMB(dir) {
    try {
        const files = await fs.promises.readdir(dir)
        const sizes = await Promise.all(files.map(async (f) => {
            try {
                const stat = await fs.promises.stat(path.join(dir, f))
                return stat.size
            } catch {
                return 0
            }
        }))
        return sizes.reduce((acc, size) => acc + size, 0) / 1_048_576
    } catch {
        return 0
    }
}
setInterval(async () => {
    try {
        if (await getTmpSizeMB(TEMP_MEDIA_DIR) > 200) {
            const files = await fs.promises.readdir(TEMP_MEDIA_DIR)
            await Promise.all(files.map(async (f) => {
                try { await fs.promises.unlink(path.join(TEMP_MEDIA_DIR, f)) } catch {}
            }))
        }
    } catch {}
}, 60_000).unref()

// ── Message store for antidelete ─────────────────────────────
const messageStore = new Map()
const commandLogCache = new Set()

setInterval(() => commandLogCache.clear(), 60_000).unref()

function logCommandUsage(message, rawText, chatId, senderId) {
    if (!rawText || message.key?.fromMe) return
    if (!message.key?.id) return
    if (commandLogCache.has(message.key.id)) return

    commandLogCache.add(message.key.id)
    const user = cleanJid(senderId).split('@')[0]
    const command = rawText.split(' ')[0]
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date())

    console.log(
        `[ CMD USED ]\n` +
        `User: ${user}\n` +
        `Command: ${command}\n` +
        `Time: ${time}`
    )
}

function getEffectiveMessage(message) {
    if (!message?.message) return null
    let current = message.message
    while (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message
    while (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message
    while (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
    return current
}

async function storeMessage(sock, message) {
    try {
        const cfg = await DB.getAntidelete()
        if (!cfg.enabled) return
        if (!message.key?.id) return

        const id     = message.key.id
        const sender = message.key.participant || message.key.remoteJid
        let content = '', mediaType = '', mediaPath = ''

        const msg = getEffectiveMessage(message)
        if (!msg) return

        const download = async (msgObj, type, ext) => {
            const stream = await downloadContentFromMessage(msgObj, type)
            let buf = Buffer.alloc(0)
            for await (const chunk of stream) buf = Buffer.concat([buf, chunk])
            const p = path.join(TEMP_MEDIA_DIR, `${id}.${ext}`)
            await writeFile(p, buf)
            return p
        }

        if (msg.imageMessage) {
            mediaType = 'image'; content = msg.imageMessage.caption || ''
            mediaPath = await download(msg.imageMessage, 'image', 'jpg')
        } else if (msg.videoMessage) {
            mediaType = 'video'; content = msg.videoMessage.caption || ''
            mediaPath = await download(msg.videoMessage, 'video', 'mp4')
        } else if (msg.audioMessage) {
            mediaType = 'audio'
            const ext = (msg.audioMessage.mimetype || '').includes('ogg') ? 'ogg' : 'mp3'
            mediaPath = await download(msg.audioMessage, 'audio', ext)
        } else if (msg.stickerMessage) {
            mediaType = 'sticker'
            mediaPath = await download(msg.stickerMessage, 'sticker', 'webp')
        } else if (msg.documentMessage) {
            const mime = msg.documentMessage.mimetype || ''
            const caption = msg.documentMessage.caption || ''
            content = caption
            if (mime.startsWith('image')) {
                mediaType = 'image'
                mediaPath = await download(msg.documentMessage, 'image', 'jpg')
            } else if (mime.startsWith('video')) {
                mediaType = 'video'
                mediaPath = await download(msg.documentMessage, 'video', 'mp4')
            } else if (mime.startsWith('audio')) {
                mediaType = 'audio'
                const ext = mime.includes('ogg') ? 'ogg' : 'mp3'
                mediaPath = await download(msg.documentMessage, 'audio', ext)
            }
        } else if (msg.conversation) {
            content = msg.conversation
        } else if (msg.extendedTextMessage?.text) {
            content = msg.extendedTextMessage.text
        }

        messageStore.set(id, {
            content, mediaType, mediaPath, sender,
            group: message.key.remoteJid.endsWith('@g.us') ? message.key.remoteJid : null,
            timestamp: new Date().toISOString(),
        })
    } catch {}
}

async function handleMessageRevocation(sock, revocationMessage) {
    try {
        const cfg = await DB.getAntidelete()
        if (!cfg.enabled) return

        const deletedMsgId = revocationMessage.message?.protocolMessage?.key?.id
        const deletedBy    = revocationMessage.participant ||
                             revocationMessage.key?.participant ||
                             revocationMessage.key?.remoteJid
        const ownerNum     = cleanJid(sock.user?.id || '') + '@s.whatsapp.net'

        if (!deletedMsgId) return
        if (cleanJid(deletedBy) === cleanJid(sock.user?.id || '')) return

        const orig = messageStore.get(deletedMsgId)
        if (!orig) return

        const senderName = orig.sender.split('@')[0]
        const time = new Date().toLocaleString()

        let text = `*⚠️ NIXIE ANTIDELETE REPORT*\n\n` +
            `*❌ Deleted By:* @${deletedBy.split('@')[0]}\n` +
            `*👤 Sender:* @${senderName}\n` +
            `*🕐 Time:* ${time}`
        if (orig.group) {
            try {
                const meta = await sock.groupMetadata(orig.group)
                text += `\n*Group:* ${meta.subject}`
            } catch {}
        }
        if (orig.content) text += `\n\n*💬 Message:*\n${orig.content}`

        await sendStyledMessage(sock, ownerNum, { text, mentions: [deletedBy, orig.sender] })

        // Also notify group if antidelete feature is enabled for that group
        try {
            if (orig.group) {
                // Inform group using hackerGuard if configured
                const { handleAntiDelete } = require('./lib/hackerGuard')
                runInBackground(() => handleAntiDelete(sock, orig.group, { id: deletedMsgId }), orig.sender).catch(() => {})
            }
        } catch (e) {}

        if (orig.mediaType && orig.mediaPath && fs.existsSync(orig.mediaPath)) {
            const opts = { caption: `*Deleted ${orig.mediaType}*`, mentions: [orig.sender] }
            try {
                if (orig.mediaType === 'image')   await sendStyledMessage(sock, ownerNum, { image: { url: orig.mediaPath }, ...opts })
                if (orig.mediaType === 'video')   await sendStyledMessage(sock, ownerNum, { video: { url: orig.mediaPath }, ...opts })
                if (orig.mediaType === 'audio')   await sendStyledMessage(sock, ownerNum, { audio: { url: orig.mediaPath }, mimetype: 'audio/mpeg', ...opts })
                if (orig.mediaType === 'sticker') await sock.sendMessage(ownerNum, { sticker: { url: orig.mediaPath } })
            } catch {}
            try { fs.unlinkSync(orig.mediaPath) } catch {}
        }
        messageStore.delete(deletedMsgId)
    } catch {}
}

// ── Anti-status handling for status updates ─────────────────
async function handleStatusUpdate(sock, statusUpdate) {
    try {
        const msgs = statusUpdate?.messages || []
        const direct = statusUpdate?.key?.remoteJid === 'status@broadcast' ? statusUpdate : null
        const msg = msgs[0] || direct
        if (!msg?.key) return
        if (msg.key.remoteJid !== 'status@broadcast') return

        await checkStatusForViolations(sock, msg)
    } catch (error) {
        console.error('Error in handleStatusUpdate:', error?.message || error)
    }
}

// ────────────────────────────────────────────────────────────
// AI HELPERS
// ────────────────────────────────────────────────────────────
const GPT_KEY    = (process.env.GPT_KEY || process.env.OPENAI_API_KEY || '').trim()
const GEMINI_KEY = (process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || '').trim()

const _chatMemoryStore = new Map()
const _aiRateLimits = new Map()
const AI_RATE_LIMIT_WINDOW = 20_000
const AI_RATE_LIMIT_MAX = 1

function _getChatMemory(chatId) {
    if (!chatId) return []
    return _chatMemoryStore.get(chatId) || []
}

function _appendChatMemory(chatId, role, content) {
    if (!chatId || !role || !content) return
    const key = chatId
    const current = _chatMemoryStore.get(key) || []
    const next = [...current, { role, content }]
    // Keep conversation history small to avoid memory and token bloat
    _chatMemoryStore.set(key, next.slice(-12))
}

function _clearChatMemory(chatId) {
    if (!chatId) return
    _chatMemoryStore.delete(chatId)
}

function isAiRateLimited(userId, maxReqs = AI_RATE_LIMIT_MAX, windowMs = AI_RATE_LIMIT_WINDOW) {
    if (!userId) return false
    const now = Date.now()
    const requests = (_aiRateLimits.get(userId) || []).filter(t => now - t < windowMs)
    if (requests.length >= maxReqs) {
        _aiRateLimits.set(userId, requests)
        return true
    }
    _aiRateLimits.set(userId, [...requests, now])
    return false
}

async function askGPT(prompt, chatId) {
    if (!GPT_KEY) return null
    const chatMemory = _getChatMemory(chatId)
    const cacheKey = chatMemory.length === 0 ? `gpt::${prompt.slice(0,50)}` : null
    if (cacheKey) {
        const cached = _getCachedApi(cacheKey)
        if (cached) return cached
    }

    const messages = [
        { role: 'system', content: 'You are NIXIE, a fast and friendly WhatsApp assistant. Keep responses concise, helpful, and natural. Use bullet points only when needed.' },
        ...chatMemory,
        { role: 'user', content: prompt }
    ]

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GPT_KEY}` },
            body: JSON.stringify({ model: process.env.GPT_MODEL || 'gpt-3.5-turbo', messages, temperature: 0.7, max_tokens: 500 }),
        })
        const data = await res.json()
        const result = data?.choices?.[0]?.message?.content?.trim() || null
        if (result) {
            if (chatId) {
                _appendChatMemory(chatId, 'user', prompt)
                _appendChatMemory(chatId, 'assistant', result)
            }
            if (cacheKey) _setCachedApi(cacheKey, result)
        }
        return result
    } catch (error) {
        console.error('askGPT error:', error?.message || error)
        return null
    }
}

async function askGemini(prompt, chatId) {
    if (!GEMINI_KEY) return null
    const chatMemory = _getChatMemory(chatId)
    const cacheKey = chatMemory.length === 0 ? `gemini::${prompt.slice(0,50)}` : null
    if (cacheKey) {
        const cached = _getCachedApi(cacheKey)
        if (cached) return cached
    }

    const model = (process.env.GEMINI_MODEL || 'gemini-1.5-flash').split(',')[0].trim()
    const textPrompt = chatMemory.length > 0
        ? `${chatMemory.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n')}\nUser: ${prompt}`
        : prompt

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: textPrompt }] }] }),
        })
        const data = await res.json()
        const result = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || null
        if (result) {
            if (chatId) {
                _appendChatMemory(chatId, 'user', prompt)
                _appendChatMemory(chatId, 'assistant', result)
            }
            if (cacheKey) _setCachedApi(cacheKey, result)
        }
        return result
    } catch (error) {
        console.error('askGemini error:', error?.message || error)
        return null
    }
}

async function askAI(prompt, chatId) {
    const useCache = _getChatMemory(chatId).length === 0
    const cacheKey = useCache ? `ai::${prompt.slice(0,50)}` : null
    if (cacheKey) {
        const cached = _getCachedApi(cacheKey)
        if (cached) return cached
    }

    let reply = await askGPT(prompt, chatId)
    if (!reply) reply = await askGemini(prompt, chatId)
    if (!reply && process.env.GROQ_API_KEY) {
        try {
            const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 500,
            }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 10_000 })
            reply = res.data?.choices?.[0]?.message?.content?.trim() || null
            if (reply && chatId) {
                _appendChatMemory(chatId, 'user', prompt)
                _appendChatMemory(chatId, 'assistant', reply)
            }
        } catch (error) {
            console.error('askAI Groq error:', error?.message || error)
        }
    }

    if (reply) {
        if (cacheKey) _setCachedApi(cacheKey, reply)
        return reply
    }

    const fallback = '⚠️ No AI service is configured. Set GPT_KEY or GEMINI_KEY.'
    if (cacheKey) _setCachedApi(cacheKey, fallback, 5_000)
    return fallback
}

// ────────────────────────────────────────────────────────────
// GAMES (TicTacToe, Hangman, Trivia)
// ────────────────────────────────────────────────────────────

function getTicTacToeMentions(game) {
    return [game.players.X, game.players.O].filter(Boolean)
}

function getTicTacToeDisplay(game) {
    return TicTacToe.formatBoard(game.board)
}

async function handleTicTacToeStart(sock, chatId, senderId, settings, isAdmin, isOwner) {
    const botMode = settings.isPublic ? 'public' : 'private'
    const result = TicTacToe.startGame(chatId, senderId, botMode, isAdmin || isOwner)

    if (!result.success) {
        if (result.error === 'existing') {
            await sendStyledMessage(sock, chatId, '❌ Game already exists.', {}, settings)
            return
        }
        if (result.error === 'private') {
            await sendStyledMessage(sock, chatId, '❌ Bot is in PRIVATE mode\nOnly admins/owner can start games', {}, settings)
            return
        }
        await sendStyledMessage(sock, chatId, '❌ Unable to start game.', {}, settings)
        return
    }

    const board = getTicTacToeDisplay(result.game)
    await sendStyledMessage(sock, chatId, `♟️ *Tic-Tac-Toe started!*\n\n${board}\n\nWaiting for an opponent to join with *.join*`, {}, settings)
}

async function handleTicTacToeMove(sock, chatId, senderId, text, settings) {
    const cleaned = text.trim().toLowerCase()
    if (/^(surrender|give up)$/i.test(cleaned)) {
        const result = TicTacToe.surrenderGame(chatId, senderId)
        if (!result.success) return

        if (result.surrender && result.winner) {
            await sendStyledMessage(sock, chatId, `🏳️ @${senderId.split('@')[0]} surrendered! @${result.winner.split('@')[0]} wins!`, { mentions: [senderId, result.winner] }, settings)
            return
        }

        await sendStyledMessage(sock, chatId, '♟️ Game cancelled.', {}, settings)
        return
    }

    if (!/^[1-9]$/.test(text.trim())) return
    const position = parseInt(text, 10)
    const result = TicTacToe.makeMove(chatId, senderId, position)

    if (!result.success) {
        switch (result.error) {
            case 'no-game':
            case 'no-active-game':
                await sendStyledMessage(sock, chatId, '❌ No active game in this chat.', {}, settings)
                return
            case 'not-in-game':
                return
            case 'not-your-turn':
                await sendStyledMessage(sock, chatId, '❌ Not your turn.', {}, settings)
                return
            case 'cell-taken':
                await sendStyledMessage(sock, chatId, '❌ Cell already taken.', {}, settings)
                return
            case 'invalid':
                await sendStyledMessage(sock, chatId, '❌ Invalid move.', {}, settings)
                return
            default:
                await sendStyledMessage(sock, chatId, '❌ Unable to process move.', {}, settings)
                return
        }
    }

    const board = getTicTacToeDisplay(result.game)
    if (result.winner) {
        await sendStyledMessage(sock, chatId, {
            text: `🏆 @${result.winner.split('@')[0]} wins!\n\n${board}`,
            mentions: [result.winner],
        }, {}, settings)
        return
    }

    if (result.draw) {
        await sendStyledMessage(sock, chatId, `🤝 It's a draw!\n\n${board}`, {}, settings)
        return
    }

    const current = result.game.players[result.game.turn]
    await sendStyledMessage(sock, chatId, {
        text: `♟️ Move accepted.\n\n${board}\n\nTurn: @${current.split('@')[0]}`,
        mentions: getTicTacToeMentions(result.game),
    }, {}, settings)
}

async function handleTicTacToeJoin(sock, chatId, senderId, settings) {
    const result = TicTacToe.joinGame(chatId, senderId)
    if (!result.success) {
        if (result.error === 'no-game') {
            await sendStyledMessage(sock, chatId, '❌ No active game in this chat.', {}, settings)
            return
        }
        if (result.error === 'existing') {
            await sendStyledMessage(sock, chatId, '❌ Game already exists.', {}, settings)
            return
        }
        if (result.error === 'already-player') {
            await sendStyledMessage(sock, chatId, '❌ You are already in this game.', {}, settings)
            return
        }
        await sendStyledMessage(sock, chatId, '❌ Unable to join game.', {}, settings)
        return
    }

    const board = getTicTacToeDisplay(result.game)
    const current = result.game.players[result.game.turn]
    await sendStyledMessage(sock, chatId, {
        text: `♟️ *Tic-Tac-Toe started!*

${board}

Turn: @${current.split('@')[0]}`,
        mentions: getTicTacToeMentions(result.game),
    }, {}, settings)
}

async function handleTicTacToeReset(sock, chatId, settings) {
    const result = TicTacToe.resetGame(chatId)
    if (!result.success) {
        await sendStyledMessage(sock, chatId, '❌ No active game in this chat.', {}, settings)
        return
    }
    await sendStyledMessage(sock, chatId, '♻️ Tic-Tac-Toe game reset. Start a new match with *.tictactoe*.', {}, settings)
}

async function tictactoeCommand(sock, chatId, senderId, fullArgs, settings, isAdmin, isOwner) {
    const command = (fullArgs || '').trim().toLowerCase()
    const args = command.split(/\s+/).filter(Boolean)
    const sub = args.shift() || ''

    if (!sub || sub === 'start') {
        await handleTicTacToeStart(sock, chatId, senderId, settings, isAdmin, isOwner)
        return
    }

    if (sub === 'join') {
        await handleTicTacToeJoin(sock, chatId, senderId, settings)
        return
    }

    if (sub === 'reset' || sub === 'restart' || sub === 'end') {
        await handleTicTacToeReset(sock, chatId, settings)
        return
    }

    if (sub === 'board' || sub === 'show') {
        const game = TicTacToe.getGame(chatId)
        if (!game) {
            await sendStyledMessage(sock, chatId, '❌ No active game in this chat.', {}, settings)
            return
        }
        const board = getTicTacToeDisplay(game)
        const current = game.players[game.turn]
        await sendStyledMessage(sock, chatId, {
            text: `♟️ Current board:\n\n${board}\n\nTurn: @${current.split('@')[0]}`,
            mentions: getTicTacToeMentions(game),
        }, {}, settings)
        return
    }

    if (/^[1-9]$/.test(sub) || sub === 'surrender' || sub === 'give' || command === 'give up') {
        const moveText = sub === 'give' ? 'give up' : fullArgs
        await handleTicTacToeMove(sock, chatId, senderId, moveText, settings)
        return
    }

    await sendStyledMessage(sock, chatId, '♟️ Tic-Tac-Toe commands:\n*.ttt* - start game\n*.ttt join* - join game\n*.ttt board* - show board\n*.ttt reset* - reset game\n*.ttt surrender* - give up\n*.ttt 1-9* - make a move', {}, settings)
}

// ── Hangman ───────────────────────────────────────────────────
const HANG_WORDS = ['javascript','nodejs','whatsapp','hangman','developer','database','mongodb','frontend','backend','network','session','command','timeout','request']
const _hangGames = Object.create(null)

async function startHangman(sock, chatId) {
    if (_hangGames[chatId]) { await sendStyledMessage(sock, chatId, '⚠️ Already running. Use *.guess <letter>*.', {}, settings); return }
    const word = HANG_WORDS[Math.floor(Math.random() * HANG_WORDS.length)]
    _hangGames[chatId] = { word, masked: Array(word.length).fill('_'), guessed: [], wrong: 0, max: 6 }
    await sendStyledMessage(sock, chatId, `🎯 Hangman started!\n\nWord: ${_hangGames[chatId].masked.join(' ')}\nGuesses left: 6\n\nUse *.guess <letter>*`, {}, settings)
}

async function guessLetter(sock, chatId, letter) {
    const g = _hangGames[chatId]
    if (!g) { await sendStyledMessage(sock, chatId, '❌ No game running. Start with *.hangman*.', {}, settings); return }
    letter = (letter || '').toLowerCase().trim()
    if (!/^[a-z]$/.test(letter)) { await sendStyledMessage(sock, chatId, '❌ Single letter only. e.g. *.guess a*', {}, settings); return }
    if (g.guessed.includes(letter)) { await sendStyledMessage(sock, chatId, `⚠️ Already guessed "${letter}"!`, {}, settings); return }
    g.guessed.push(letter)
    if (g.word.includes(letter)) {
        g.word.split('').forEach((c, i) => { if (c === letter) g.masked[i] = letter })
        if (!g.masked.includes('_')) {
            await sendStyledMessage(sock, chatId, `🎉 You got it! Word was: *${g.word}*`, {}, settings)
            delete _hangGames[chatId]; return
        }
        await sendStyledMessage(sock, chatId, `✅ Correct!\n\nWord: ${g.masked.join(' ')}\nGuessed: ${g.guessed.join(', ')}\nLeft: ${g.max - g.wrong}`, {}, settings)
    } else {
        g.wrong++
        if (g.max - g.wrong <= 0) {
            await sendStyledMessage(sock, chatId, `💀 Game over! Word was: *${g.word}*`, {}, settings)
            delete _hangGames[chatId]; return
        }
        await sendStyledMessage(sock, chatId, `❌ Wrong! ${g.max - g.wrong} tries left.\n\nWord: ${g.masked.join(' ')}\nGuessed: ${g.guessed.join(', ')}`, {}, settings)
    }
}

// ── Trivia ────────────────────────────────────────────────────
const _triviaGames = Object.create(null)
const _dec = s => String(s || '').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')

async function startTrivia(sock, chatId) {
    if (_triviaGames[chatId]) { await sendStyledMessage(sock, chatId, '⚠️ Game in progress. Use *.answer <1-4>*.', {}, settings); return }
    try {
        const res  = await axios.get('https://opentdb.com/api.php?amount=1&type=multiple', { timeout: 20_000 })
        const q    = res.data?.results?.[0]
        if (!q) throw new Error('no question')
        const correct  = _dec(q.correct_answer)
        const options  = [...q.incorrect_answers.map(_dec), correct].sort(() => Math.random() - .5)
        _triviaGames[chatId] = { question: _dec(q.question), correctAnswer: correct, options }
        const lines = options.map((o, i) => `${i+1}. ${o}`).join('\n')
        await sendStyledMessage(sock, chatId, `🧠 *Trivia!*\n\n${_triviaGames[chatId].question}\n\n${lines}\n\nReply *.answer 1-4*`, {}, settings)
    } catch { await sendStyledMessage(sock, chatId, '❌ Failed to load question.', {}, settings) }
}

async function answerTrivia(sock, chatId, raw) {
    const g = _triviaGames[chatId]
    if (!g) { await sendStyledMessage(sock, chatId, '❌ No trivia game. Start with *.trivia*.', {}, settings); return }
    const n = Number(raw?.trim())
    const picked = Number.isInteger(n) && n >= 1 && n <= g.options.length ? g.options[n-1] : raw?.trim()
    const ok     = picked?.toLowerCase() === g.correctAnswer.toLowerCase()
    await sendStyledMessage(sock, chatId, ok ? `✅ Correct! Answer: *${g.correctAnswer}*` : `❌ Wrong! Answer: *${g.correctAnswer}*`, {}, settings)
    delete _triviaGames[chatId]
}

// ── Video generation ──────────────────────────────────────────
async function soraCommand(sock, chatId, message, prompt) {
    if (!prompt) { await sendStyledMessage(sock, chatId, `Usage: ${PREFIXES[0]}sora <description>`, { quoted: message }, settings); return }
    try {
        await sendStyledMessage(sock, chatId, '🎬 Generating video...', { quoted: message }, settings)
        const { data } = await axios.get(`https://okatsu-rolezapiiz.vercel.app/ai/txt2video?text=${encodeURIComponent(prompt)}`, { timeout: 60_000 })
        const url = data?.videoUrl || data?.result || data?.data?.videoUrl
        if (!url) throw new Error('no url')
        await sendStyledMessage(sock, chatId, { video: { url }, mimetype: 'video/mp4', caption: `Prompt: ${prompt}` }, { quoted: message }, settings)
    } catch { await sendStyledMessage(sock, chatId, '❌ Video generation failed.', { quoted: message }, settings) }
}

// ── Download helpers ──────────────────────────────────────────
async function tryRequest(fn, attempts = 3) {
    let last
    for (let i = 1; i <= attempts; i++) {
        try { return await fn() } catch (e) { last = e; if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i)) }
    }
    throw last
}


// ────────────────────────────────────────────────────────────  
// SMART PREFIX & NATURAL LANGUAGE ROUTER
// ────────────────────────────────────────────────────────────  

function normalizeUserMode(mode) {
    const text = String(mode || '').toLowerCase().trim()
    return ['strict', 'smart', 'ai'].includes(text) ? text : 'strict'
}

function detectSmartCommand(text, mode) {
    if (!text || !text.trim()) return null
    const trimmed = text.trim()
    const lower = trimmed.toLowerCase()

    const removePrefix = (regex) => {
        const match = trimmed.match(regex)
        return match ? match[1].trim() : null
    }

    const play = removePrefix(/^(?:play|listen(?: to)?|search(?: for)?|search)\s+(.+)$/i)
    if (play) return { cmd: 'play', args: [play], fullArgs: play }

    const tm = removePrefix(/^(?:tm|textmaker)\s+(.+)$/i)
    if (tm) return { cmd: 'tm', args: tm.split(' '), fullArgs: tm }

    const misc = removePrefix(/^(?:misc)\s+(.+)$/i)
    if (misc) return { cmd: 'misc', args: misc.split(' '), fullArgs: misc }

    const imagine = removePrefix(/^(?:imagine|create image|generate image)\s+(.+)$/i)
    if (imagine) return { cmd: 'imagine', args: [imagine], fullArgs: imagine }

    const nixieGroupToggle = trimmed.match(/^(?:nixie|assistant|bot)\s+(on|off|start|wake|enable|stop|sleep|disable)\b/i)
    if (nixieGroupToggle) {
        const rawAction = nixieGroupToggle[1].toLowerCase()
        const action = /^(?:on|start|wake|enable)$/i.test(rawAction) ? 'on' : 'off'
        return { cmd: 'bot', args: [action], fullArgs: action, meta: { chatbotToggle: true } }
    }

    const nixieChat = /^(?:nixie|assistant|bot)\b/i.test(lower)
    if (mode === 'ai' && !trimmed.match(/^(?:play|tm|misc|imagine)\b/i)) {
        return { cmd: 'ai', args: [trimmed], fullArgs: trimmed }
    }
    if (nixieChat && /\b(on|off|start|stop|wake|sleep|enable|disable)\b/i.test(lower) === false) {
        const query = trimmed.replace(/^(?:nixie|assistant|bot)\s*/i, '').trim() || trimmed
        return { cmd: 'nixie', args: [query], fullArgs: query }
    }

    const questionLike = /^(?:what|who|when|where|why|how|define|explain|tell me|describe|show me|generate|create|search)\b/i.test(lower) || lower.endsWith('?')
    if (mode === 'ai' || (mode === 'smart' && questionLike)) {
        return { cmd: 'ai', args: [trimmed], fullArgs: trimmed }
    }

    return null
}

function isPrefixCommand(text, prefix) {
    if (typeof prefix !== 'string') return false
    const normalized = String(text || '').trim()
    if (prefix === '') return normalized.length > 0
    return normalized.startsWith(prefix)
}

// ── Message deduplication (prevent duplicate event processing) ─────────────
const _seenMessages = new Map() // messageId -> timestamp
const DEDUP_WINDOW = 3000 // 3 second dedup window
const _perUserProcessing = new Map() // userId -> { processing: bool, queue: [] }

function isDuplicateMessage(messageId) {
    const now = Date.now()
    const lastSeen = _seenMessages.get(messageId)
    if (!lastSeen) {
        _seenMessages.set(messageId, now)
        return false
    }
    if (now - lastSeen < DEDUP_WINDOW) return true
    _seenMessages.set(messageId, now)
    return false
}

setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _seenMessages) {
        if (now - v > DEDUP_WINDOW * 10) _seenMessages.delete(k)
    }
}, 30_000).unref()

// ────────────────────────────────────────────────────────────
// OPTIMIZED MESSAGE HANDLER — uses batch settings, instant reactions, parallel processing
// ────────────────────────────────────────────────────────────

async function handleMessages(sock, messageUpdate) {
    const { messages, type } = messageUpdate  

    // Handle deletions (protocol messages)  
    if (type === 'protocol') {  
        const msg = messages[0]  
        if (msg?.message?.protocolMessage?.type === 0) {
            const rid = msg.key.participant || msg.key.remoteJid
            runInBackground(() => handleMessageRevocation(sock, msg), rid).catch(() => {})
        }
        return  
    }  

    if (type !== 'notify' && type !== 'append') return  

    const message = messages[0]  
    if (!message?.message) return  
    if (message.key?.fromMe) return

    const handlerStartedAt = Date.now()

    // ★ METRIC: Record message processing
    recordMetric('messagesProcessed')
    
    // Deduplicate: ignore if we've already processed this message ID in the last 3 seconds
    const msgId = message.key?.id
    if (msgId && isDuplicateMessage(msgId)) {
        return
    }

    const chatId   = message.key.remoteJid  
    const senderId = getUserId(message)
    const isGroup  = chatId.endsWith('@g.us')  

    const rawText = extractMessageText(message)
    const userMessage = rawText.toLowerCase()

    // Lightweight debug: show incoming raw text and parsed lower-cased message
    // when DEBUG_COMMANDS=1 (existing) or DEBUG_COMMANDS_VERBOSE=1 (extra verbosity)
    if (process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1') {
        try {
            console.log(`[cmd_debug] incoming -> chat=${chatId} sender=${senderId} isGroup=${isGroup} rawText=${JSON.stringify(rawText)} userMessage=${JSON.stringify(userMessage)}`)
        } catch (e) {
            console.error('[cmd_debug] failed to log incoming message:', e?.stack || e)
        }
    }

    logCommandUsage(message, rawText, chatId, senderId)

    // Store message for delete command (async, non-blocking, per-user)
    runInBackground(() => {
        try { store.addMessage(chatId, message) } catch {}
    }, senderId).catch(() => {})

    // ── Owner / connected user detection ──────────────────────  
    // Be defensive: sock.user may not be populated immediately after reconnect.
    // Fall back to auth creds (if present) which contains the same 'me' id.
    const _rawBotId = sock.user?.id || (sock?.auth && sock.auth.creds && sock.auth.creds.me && sock.auth.creds.me.id) || ''
    const _rawBotLid = sock.user?.lid || (sock?.auth && sock.auth.creds && sock.auth.creds.me && sock.auth.creds.me.lid) || ''
    const botJidClean = cleanJid(_rawBotId || '').split('@')[0]
    const botLidClean = cleanJid(_rawBotLid || '').split('@')[0]
    const senderNum   = cleanJid(senderId).split('@')[0]  
    const isConnected = message.key.fromMe ||  
        senderNum === botJidClean ||  
        senderNum === botLidClean  

    const botNum = botJidClean || botLidClean || 'default'  

    // ═══════════════════════════════════════════════════════════  
    // ★ BATCH LOAD ALL SETTINGS IN ONE CALL ★
    // ═══════════════════════════════════════════════════════════  
    let settings
    try {
        settings = await loadMessageSettings(botNum, chatId, senderId, isGroup)
    } catch (e) {
        console.error(`[cmd] failed to load message settings for bot=${botNum} chat=${chatId} sender=${senderId}:`, e?.message || e)
        settings = {
            botState: { isOn: true },
            isPublic: true,
            owners: [],
            banned: [],
            pmBlocker: { enabled: false, message: '🚫 PMs are disabled.' },
            antidelete: { enabled: false },
            antisticker: { enabled: false },
            antilink: { enabled: false, action: 'delete' },
            antibadword: { enabled: false, words: [] },
            mutedUsers: [],
            isWelcomeOn: false,
            isGoodbyeOn: false,
            isChatbotOn: false,
            mods: [],
            autoread: false,
            autoreact: false,
            autotyping: false,
            autoreply: { enabled: false, replies: {} },
            mentionReply: { enabled: false, message: '' },
            antispam: { enabled: false },
            userPrefix: '.',
            userMode: 'strict',
        }
    }

    const ownerNumberClean = cleanJid(settings.ownerNumber).split('@')[0]
    const ownerNumbers = Array.isArray(settings.owners) ? settings.owners : [settings.owners].filter(Boolean)
    const isOwner = isConnected || ownerNumbers.some(o => cleanJid(o).split('@')[0] === senderNum) || ownerNumberClean === senderNum
    const modePublic = settings.isPublic !== false
    const shouldCheckAdmin = isGroup && (
        !modePublic ||
        settings.antilink?.enabled ||
        settings.antibadword?.enabled ||
        settings.antispam?.enabled ||
        settings.antisticker?.enabled ||
        settings.isChatbotOn
    )
    const adminInfoPromise = shouldCheckAdmin ? checkAdmin(sock, chatId, senderId) : Promise.resolve({ isBotAdmin: false, isSenderAdmin: false })

    // ── AUTO-ADD NEW PRIVATE CONTACTS ─────────────────────
    try {
        if (!isGroup && !message.key.fromMe && settings.autoAdd?.enabled) {
            const cfg = settings.autoAdd || {}
            const addedFeature = await DB.getFeature('autoAddUsers') || {}
            const addedUsers = Array.isArray(addedFeature?.users) ? addedFeature.users : []
            const newUserJid = cleanJid(senderId)
            // Avoid duplicates
            if (!addedUsers.includes(newUserJid)) {
                // Try to add to group if configured
                if (cfg.tryAddToGroup && cfg.groupJid) {
                    try {
                        await sock.groupParticipantsUpdate(cfg.groupJid, [newUserJid], 'add')
                        addedUsers.push(newUserJid)
                        await DB.setFeature('autoAddUsers', { users: addedUsers })
                    } catch (e) {
                        // failed to add silently; do not notify user to keep joins silent
                    }
                } else {
                    // No groupJid configured for direct add, so mark as added and send invite links silently
                    addedUsers.push(newUserJid)
                    await DB.setFeature('autoAddUsers', { users: addedUsers })
                    
                    // Send group invite link if configured
                    if (cfg.groupInviteLink) {
                        runInBackground(() => 
                            sock.sendMessage(newUserJid, { text: cfg.groupInviteLink }).catch(() => {}), newUserJid
                        )
                    }
                }

                // Send channel link if configured
                if (cfg.sendChannelLink && cfg.channelLink) {
                    runInBackground(() => 
                        sock.sendMessage(newUserJid, { text: cfg.channelLink }).catch(() => {}), newUserJid
                    )
                }
            }
        }
    } catch (e) {
        console.error('[auto-add] error:', e?.message || e)
    }

    // ── Rate limit (skip owner) ───────────────────────────────
    if (!isOwner && isRateLimited(senderId)) return

    const normalizedSenderId = cleanJid(senderId)
    const roleInfo = await Permission.checkRole(senderId, isGroup ? chatId : null)
    const isMod = roleInfo.isModerator
    const isAdmin = roleInfo.isAdmin

    let isSenderAdmin = false
    if (isGroup) {
        const adminInfo = await adminInfoPromise
        isSenderAdmin = adminInfo.isSenderAdmin
    }

    // ── Initialize command flag early (before any async tasks) ──────────────────────
    let isCommand = false
    const userPrefix = typeof settings.userPrefix === 'string' ? settings.userPrefix : (PREFIXES[0] || '.')
    const userMode = normalizeUserMode(settings.userMode)
    const isCommandPrefix = isPrefixCommand(rawText, userPrefix)

    let commandContext = null
    if (isCommandPrefix) {
        const trimmedText = rawText.trim()
        const cmdBody = userPrefix === '' ? trimmedText : trimmedText.slice(userPrefix.length).trim()
        const cmdName = cmdBody.split(' ')[0].toLowerCase()
        const args = cmdBody.split(' ').slice(1)
        const fullArgs = cmdBody.slice(cmdName.length).trim()
        commandContext = { type: 'prefix', cmd: cmdName, args, fullArgs }
        isCommand = cmdBody.length > 0
    }

    // Run anti checks in background (non-blocking, per-user)
    runInBackground(async () => {
        const checks = [
            // Antilink
            (async () => {
                try {
                    if (settings.antilink?.enabled && userMessage && /https?:\/\//i.test(userMessage)) {
                        const { isSenderAdmin } = await adminInfoPromise
                        if (!isSenderAdmin) {
                            await sock.sendMessage(chatId, { delete: message.key }).catch(() => {})
                            await sendStyledMessage(sock, chatId, { text: `🚫 @${senderId.split('@')[0]} posted a link!`, mentions: [senderId] }, {}, settings).catch(() => {})
                            const act = settings.antilink?.action || 'delete'
                            await handleAction(act, { chatId, senderId, messageKey: message.key })
                        }
                    }
                } catch {}
            })(),

            // Antibadword
            (async () => {
                try {
                    if (settings.antibadword?.enabled && userMessage) {
                        const badWords = settings.antibadword?.words || []
                        const txt = userMessage.toLowerCase()
                        const found = badWords.find(w => w && txt.includes(w.toLowerCase()))
                        if (found) {
                            const { isSenderAdmin } = await adminInfoPromise
                            if (!isSenderAdmin) {
                                await sock.sendMessage(chatId, { delete: message.key }).catch(() => {})
                                const act = settings.antibadword?.action || 'delete'
                                await handleAction(act, { chatId, senderId, messageKey: message.key })
                            }
                        }
                    }
                } catch {}
            })(),

            // Antispam
            (async () => {
                try {
                    const spamming = await DB.checkSpam(chatId, senderId)
                    if (spamming) {
                        const { isSenderAdmin } = await adminInfoPromise
                        if (!isSenderAdmin) {
                            await sock.sendMessage(chatId, { delete: message.key }).catch(() => {})
                            await sendStyledMessage(sock, chatId, { text: `🚫 @${senderId.split('@')[0]} stop spamming!`, mentions: [senderId] }, {}, settings).catch(() => {})
                            const act = settings.antispam?.action || 'delete'
                            await handleAction(act, { chatId, senderId, messageKey: message.key })
                            try { await DB.resetSpam(chatId, senderId) } catch {}
                        }
                    }
                } catch {}
            })(),

            // Antisticker
            (async () => {
                try {
                    if (settings.antisticker?.enabled && message.message?.stickerMessage) {
                        const { isSenderAdmin } = await adminInfoPromise
                        if (!isSenderAdmin) {
                            await sock.sendMessage(chatId, { delete: message.key }).catch(() => {})
                            const act = settings.antisticker?.action || 'delete'
                            await handleAction(act, { chatId, senderId, messageKey: message.key })
                        }
                    }
                } catch {}
            })(),

            // Anti-status tagging
            (async () => {
                try {
                    if (isGroup) {
                        await checkMessageForViolations(sock, message)
                    }
                } catch {}
            })(),
        ]

        // Execute all checks in parallel
        await Promise.all(checks).catch(() => {})
    }, senderId).catch(() => {})

    // ── Auto-read ─────────────────────────────────────────────  
    if (settings.autoread && !message.key.fromMe) {
        runInBackground(() => sock.readMessages([message.key]).catch(() => {}), senderId)
    }

    // ── Auto-react (instant, non-blocking) ─────────────────────  
    if (settings.autoreact && !message.key.fromMe && userMessage) {  
        const emojis = ['❤️','😂','😮','😢','👍','🔥','🎉','💯','😎','🙌']  
        runInBackground(() => 
            sock.sendMessage(chatId, { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: message.key } }).catch(() => {}), senderId
        )
    }

    // ── Autoreply (non-blocking) ──────────────────────────────  
    if (!message.key.fromMe && userMessage && !isCommand) {
        if (settings.autoreply?.enabled && settings.autoreply.replies) {  
            for (const [trigger, resp] of Object.entries(settings.autoreply.replies)) {  
                if (userMessage.includes(trigger.toLowerCase())) {  
                    runInBackground(() => 
                        sendStyledMessage(sock, chatId, { text: resp }, { quoted: message }, settings), senderId
                    )
                    return  
                }  
            }  
        }  
    }  

    // ── Mention reply (non-blocking) ──────────────────────────  
    if (!message.key.fromMe) {  
        if (settings.mentionReply?.enabled && settings.mentionReply.message) {  
            const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []  
            const mentioned = mentionedJids.some(j => cleanJid(j).split('@')[0] === botJidClean)  
            if (mentioned) {
                runInBackground(() => 
                    sendStyledMessage(sock, chatId, { text: settings.mentionReply.message }, { quoted: message }, settings), senderId
                )
            }
        }  
    }

    // ── Store for antidelete (async) ──────────────────────────  
    runInBackground(async () => {
        try { await storeMessage(sock, message) } catch {}
    }, senderId).catch(() => {})

    // ── PM blocker (non-blocking) ──────────────────────────────  
    if (!isGroup && !message.key.fromMe && !isCommand) {  
        if (settings.pmBlocker?.enabled) {  
            runInBackground(() => 
                sendStyledMessage(sock, chatId, settings.pmBlocker.message || '🚫 PMs are disabled.', { quoted: message }, settings).catch(() => {}), senderId
            )
            return  
        }  
    }  

    // ── Muted users: delete all messages ───────────────────────
    if (isGroup && settings.mutedUsers?.includes(senderId) && !isOwner) {
        await sock.sendMessage(chatId, { delete: message.key }).catch(() => {})
        return
    }

    // ═══════════════════════════════════════════════════════════
    // 🔐 HACKER GUARD SECURITY CHECKS (Non-blocking, per-user)
    // ═══════════════════════════════════════════════════════════
    if (isGroup) {
        // Store all messages for anti-delete feature
        runInBackground(() => storeMessageForGuard(chatId, message), senderId).catch(() => {})

        // Anti-sticker check
        const isSticker = !!getEffectiveMessage(message)?.stickerMessage
        if (isSticker) {
            runInBackground(() => handleAntiSticker(sock, chatId, senderId, message), senderId).catch(() => {})
        }

        // Anti-badword check
        if (rawText) {
            runInBackground(() => handleAntiBadword(sock, chatId, senderId, rawText), senderId).catch(() => {})
        }

        // Anti-link check
        if (rawText) {
            const { handleAntiLink, handleAntiSpam } = require('./lib/hackerGuard')
            runInBackground(() => handleAntiLink(sock, chatId, senderId, rawText, message), senderId).catch(() => {})
            runInBackground(() => handleAntiSpam(sock, chatId, senderId, rawText), senderId).catch(() => {})
        }

        // Anti-bot check
        runInBackground(() => handleAntiBot(sock, messageUpdate, chatId, senderId), senderId).catch(() => {})
    }

    if (process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1') {
        try {
            console.log(`[cmd_debug] prefix check -> chat=${chatId} sender=${senderId} prefix=${JSON.stringify(userPrefix)} isCommandPrefix=${isCommandPrefix} rawText=${JSON.stringify(rawText)}`)
        } catch (e) {
            console.error('[cmd_debug] failed to log prefix check:', e?.stack || e)
        }
    }

    const sendCommandAck = async () => {
        if (!message?.key || message.key?.fromMe) return
        await sock.sendMessage(chatId, { react: { text: '⚡', key: message.key } }).catch(() => {})
    }

    if (!isCommand) {
        const tttMove = /^[1-9]$/.test(userMessage) || /^(surrender|give up)$/i.test(userMessage)
        if (tttMove) {
            await handleTicTacToeMove(sock, chatId, senderId, userMessage)
            return
        }

        if (['smart', 'ai'].includes(userMode)) {
            const smart = detectSmartCommand(rawText, userMode)
            if (smart) {
                commandContext = { type: 'smart', ...smart }
                isCommand = true
            }
        }

        if (!isCommand && isGroup && settings.isChatbotOn) {
            const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            const botMentioned = mentionedJids.some(j => cleanJid(j).split('@')[0] === botJidClean)
            const beginsWithNixie = /^(?:nixie|assistant|bot)\b/i.test(rawText)
            const questionLike = /^(?:what|who|when|where|why|how|define|explain|tell me|describe|show me|generate|create|search)\b/i.test(userMessage) || rawText.trim().endsWith('?')
            if (botMentioned || beginsWithNixie || questionLike) {
                commandContext = { type: 'chatbot', cmd: 'nixie', args: [rawText], fullArgs: rawText }
                isCommand = true
            }
        }
    }

    if (!isCommand) return

    if (process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1') {
        try {
            console.log(`[cmd_debug] parsed command -> chat=${chatId} sender=${senderId} cmd=${JSON.stringify(commandContext?.cmd || null)} args=${JSON.stringify(commandContext?.args || [])} fullArgs=${JSON.stringify(commandContext?.fullArgs || '')}`)
        } catch (e) {
            console.error('[cmd_debug] failed to log parsed command:', e?.stack || e)
        }
    }

    // ── User cooldown check (prevent spam) ─────────────────────
    if (!isOwner && isUserOnCooldown(senderId)) return

    const cmd      = commandContext.cmd
    const args     = commandContext.args || []
    const fullArgs = commandContext.fullArgs || ''

    const quoted       = message.message?.extendedTextMessage?.contextInfo  
    const mentioned    = quoted?.mentionedJid || []  
    const quotedSender = quoted?.participant || null  
    const quotedMsg    = quoted?.quotedMessage || null  

    // ★ STRUCTURED LOGGING ★
    logCmd(senderId, `.${cmd}`)

    // ── Muted users check (prevent command execution) ─────────
    if (settings.mutedUsers?.includes(senderId) && cmd !== 'unmute-user' && !isOwner) {
        return
    }

    // ── Bot state check ───────────────────────────────────────
    if (!settings.botState.isOn && !isOwner && cmd !== 'bot') {
        await sendStyledMessage(sock, chatId, '🔴 Bot is OFF. Only the owner can turn it back on.', { quoted: message }, settings)
        return
    }

    // ── Mode check ────────────────────────────────────────────
    // All parsed commands are now allowed in DMs and groups when the bot is active.

    // ── Ban check (skip if owner) ─────────────────────────────
    if (settings.banned.includes(senderId) && cmd !== 'unban' && !isOwner) {
        if (Math.random() < 0.1) await sendStyledMessage(sock, chatId, '🚫 You are banned from using this bot!', {}, settings)
        return
    }

    // ── Auto-typing ───────────────────────────────────────────
    if (settings.autotyping) sock.sendPresenceUpdate('composing', chatId).catch(() => {})

    // ── Process command (queue heavy ones) ────────────────────
    const heavyCmds = ['video','play','song','ytmp3','ytmp4','img','imagine','sticker','gpt','ai','sora','lyrics','removebg','remini','blur']
    const isHeavy   = heavyCmds.includes(cmd)

    const runCmd = () => processCommand(sock, message, cmd, args, fullArgs, chatId, senderId, isOwner, isMod, isAdmin, botNum, modePublic, isGroup, mentioned, quotedSender, quotedMsg, userMessage, rawText, settings, commandContext?.meta)

    try {
        const _cmdLabel = `cmd:${cmd}:${cleanJid(senderId)}`
        const debugTime = process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1'
        if (debugTime) {
            try { console.log(`[cmd_debug] execution started -> .${cmd} chat=${chatId} sender=${senderId} isHeavy=${isHeavy} isOwner=${isOwner} isMod=${isMod} isAdmin=${isAdmin} isGroup=${isGroup}`) } catch (e) {
                console.error('[cmd_debug] failed to log execution start:', e?.stack || e)
            }
        }
        if (isHeavy) {
            if (process.env.DEBUG_COMMANDS === '1') {
                console.log('[cmd] heavy command queue run', { senderId, cmd, runCmdType: typeof runCmd })
            }
            sendLoadingReaction().catch(() => {})
            queue.run(senderId, async () => {
                if (debugTime) console.time(_cmdLabel)
                try { return await runCmd() } finally { if (debugTime) console.timeEnd(_cmdLabel) }
            }).catch((err) => {
                console.error(`[cmd] heavy command failed for .${cmd}:`, err?.message || err)
                sendStyledMessage(sock, chatId, '⚠️ Command failed. Please try again in a moment.', { quoted: message }, settings).catch(() => {})
            })
            return
        }

        sendCommandAck().catch(() => {})
        if (debugTime) console.time(_cmdLabel)
        try { await runCmd() } finally { if (debugTime) console.timeEnd(_cmdLabel) }
    } catch (e) {
        console.error(`[cmd] command execution failed for .${cmd}:`, e?.message || e)
        if (e?.stack) console.error(e.stack)
        if (process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1') {
            console.error(`[cmd_debug] execution error -> .${cmd} chat=${chatId} sender=${senderId}`)
        }
    }
}

// ────────────────────────────────────────────────────────────
// COMMAND PROCESSOR
// ────────────────────────────────────────────────────────────
async function processCommand(sock, message, cmd, args, fullArgs, chatId, senderId, isOwner, isMod, isAdmin, botNum, isPublic, isGroup, mentioned, quotedSender, quotedMsg, userMessage, rawText, settings, commandMeta = {}) {
    const p = (settings?.userPrefix !== undefined ? settings.userPrefix : PREFIXES[0]) || '.'
    const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY

    if (process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1') {
        try {
            console.log(`[cmd_debug] dispatching command -> .${cmd} chat=${chatId} sender=${senderId} args=${JSON.stringify(args)} fullArgs=${JSON.stringify(fullArgs)}`)
        } catch (e) {
            console.error('[cmd_debug] failed to log command dispatch:', e?.stack || e)
        }
    }

    // Helper to send reply
    const reply = (content) => sendStyledMessage(sock, chatId, content, { quoted: message }, settings)

    if (cmd === 'health') {
        const snapshot = global.__nixieRuntime?.getSnapshot?.() || {}
        const mongoState = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
        const redisState = global.__redisConnected ? 'Connected' : 'Disconnected'
        const lines = [
            '📡 Socket Status: ' + (snapshot.socketStatus || 'closed'),
            '🔌 WebSocket State: ' + (snapshot.connectedSessions > 0 ? 'OPEN' : 'CLOSED'),
            '✅ Authenticated: ' + (snapshot.authenticatedSessions > 0 ? 'Yes' : 'No'),
            '🗄️ MongoDB Status: ' + mongoState,
            '🧠 Redis Status: ' + redisState,
            '👥 Connected Sessions: ' + (snapshot.sessionCount || 0),
            '🔁 Reconnect Count: ' + (snapshot.reconnectAttempts || 0),
            '👂 Listener Count: ' + (snapshot.listenerCount || 0),
            '🧮 Memory Usage: ' + (snapshot.memoryUsageMB || 0) + 'MB',
            '🧠 CPU Usage: ' + (snapshot.cpuUsageUser || 0) + ' / ' + (snapshot.cpuUsageSystem || 0),
            '⏱️ Uptime: ' + (snapshot.uptimeSeconds || 0) + 's',
            '💬 Last Message: ' + (snapshot.lastMessageTimestamp || 'none'),
            '💓 Last Heartbeat: ' + (snapshot.lastHeartbeat || 'none'),
            '🆔 Current Socket ID: ' + (snapshot.currentSocketId || 'none'),
        ]
        await reply(lines.join('\n'))
        return
    }
    
    // Send instant loading reaction for heavy commands
    const sendLoadingReaction = async () => {
        await sock.sendMessage(chatId, { react: { text: '⚡', key: message.key } }).catch(() => {})
    }

    const searchUnsplashImage = async (query) => {
        if (!query) return null
        const url = 'https://api.unsplash.com/search/photos'
        const response = await axios.get(url, {
            ...AXIOS_DEFAULTS,
            params: {
                query,
                client_id: UNSPLASH_ACCESS_KEY,
                per_page: 20,
            },
        })
        if (!response?.data || !Array.isArray(response.data.results)) {
            throw new Error('Invalid Unsplash response')
        }
        const images = response.data.results.filter(item => item?.urls?.regular)
        if (!images.length) return null
        const result = images[Math.floor(Math.random() * images.length)]
        return result.urls.regular
    }
    
    // Admin guard
    const requireAdmin = async () => {
        if (!isGroup) { await reply('❌ Groups only!'); return false }
        const { isBotAdmin, isSenderAdmin } = await checkAdmin(sock, chatId, senderId)
        if (!isBotAdmin) { await reply('❌ Make me an admin first!'); return false }
        if (!isSenderAdmin && !isOwner && !isAdmin) { await reply('❌ Admins only!'); return false }
        return true
    }
    const requireOwner = async () => {
        if (!isOwner) { await reply('❌ Owner only!'); return false }
        return true
    }
    const requireOwnerOrModerator = async () => {
        if (isOwner || isMod) return true
        await reply('❌ Only the owner or group moderators can use this command.')
        return false
    }
    const requireGroupSettingPermission = async (fieldName) => {
        if (!isGroup) { await reply('❌ Groups only!'); return false }
        if (!await Permission.canManageGroupSetting(senderId, chatId, fieldName)) {
            await reply('❌ You do not have permission to change that setting.')
            return false
        }
        return true
    }
    const normalizeTargetJid = (rawTarget) => {
        if (!rawTarget) return null
        let target = String(rawTarget).trim()
        target = target.replace(/^@/, '')
        if (/^\d+$/.test(target)) {
            target = `${target}@s.whatsapp.net`
        } else if (!target.includes('@')) {
            target = `${target.replace(/^\+/, '')}@s.whatsapp.net`
        }
        return cleanJid(target)
    }

    switch (cmd) {

    // ── PING ────────────────────────────────────────────────
    case 'ping': {
        try {
            await sendLoadingReaction()
            const start = Date.now()

            const frames = [
                `┌───────────────────────────────────────────────┐
│  NIXIE NETWORK DIAGNOSTICS  ·  ACTIVE SESSION  │
└───────────────────────────────────────────────┘

[..........]  0%   • initializing network stack...`,
                `┌───────────────────────────────────────────────┐
│  NIXIE NETWORK DIAGNOSTICS  ·  ACTIVE SESSION  │
└───────────────────────────────────────────────┘

[■■........] 10%   • sending packets...`,
                `┌───────────────────────────────────────────────┐
│  NIXIE NETWORK DIAGNOSTICS  ·  ACTIVE SESSION  │
└───────────────────────────────────────────────┘

[■■■■■.....] 45%   • connecting server...`,
                `┌───────────────────────────────────────────────┐
│  NIXIE NETWORK DIAGNOSTICS  ·  ACTIVE SESSION  │
└───────────────────────────────────────────────┘

[■■■■■■■■..] 80%   • measuring latency...`,
            ]

            const latency = Date.now() - start
            const status = latency < 100 ? 'ONLINE  · STABLE' : latency < 300 ? 'ONLINE  · MODERATE' : 'ONLINE  · SLOW'
            const speed = latency < 100 ? 'ULTRA FAST' : latency < 300 ? 'GOOD' : 'RESTRICTED'
            const quality = latency < 100 ? 'PRIME' : latency < 300 ? 'STANDARD' : 'DEGRADED'

            const result = `┌───────────────────────────────────────────────┐
│  NETWORK DIAGNOSTIC REPORT  ·  NIXIE SYSTEM    │
└───────────────────────────────────────────────┘

╔═══════════════════════════════════════════════╗
║  Ping        : *${latency}ms*                          ║
║  Server      : *${status}*                    ║
║  Speed       : *${speed}*                        ║
║  Quality     : *${quality}*                     ║
║  Online      : *🟢 ACTIVE*                         ║
╚═══════════════════════════════════════════════╝`

            if (settings.animatedResponses) {
                await sendAnimatedText(sock, chatId, [...frames, result], message, 300, settings)
            } else {
                await sendStyledMessage(sock, chatId, { text: result }, { quoted: message }, settings)
            }
        } catch (e) {
            const latency = Date.now() - (global?.botStartTime || Date.now())
            const fallback = `Ping: ${latency}ms`
            await reply(fallback)
        }
        break
    }

    // ── ALIVE ───────────────────────────────────────────────
    case 'alive': {
        try {
            await sendLoadingReaction()
            const runtime = formatUptime(Date.now() - global.botStartTime)
            const frames = [
                `> booting nixie.exe...`,
                `> loading modules...`,
                `> checking services...`,
                `> online ✓`,
                `╔═════════════════════════╗\n║   𝙽𝙸𝚇𝙸𝙴 𝙰𝙻𝙸𝚅𝙴   ║\n╚═════════════════════════╝\n\n🤖 Bot: ${settings.botName || 'NIXIE'}\n🟢 Status: Active`
            ]
            if (settings.animatedResponses) {
                await sendAnimatedText(sock, chatId, frames, message, 300, settings)
            } else {
                await sendStyledMessage(sock, chatId, { text: frames[frames.length - 1] }, { quoted: message }, settings)
            }
        } catch (e) {
            await reply(`🤖 ${settings.botName || 'NIXIE'} is online!`)
        }
        break
    }

    // ── UPTIME ──────────────────────────────────────────────
    case 'uptime': {
        try {
            await sendLoadingReaction()
            const uptime = formatUptime(Date.now() - global.botStartTime)
            const mode = await DB.getMode(botNum)
            
            const frames = [
                `*[ NIXIE ]*

  ⚡ INITIALIZING UPTIME...
  SYSTEM CHECK ▮▮▮▮▮▮▮▮░░ 0%`,
                `*[ NIXIE ]*

  🔄 PROCESSING DATA...
  SYSTEM CHECK ▮▮▮▮▮▮▮▮░░ 15%`,
                `*[ NIXIE ]*

  🧮 CALCULATING...
  SYSTEM CHECK ▮▮▮▮▮▮▮▮░░ 35%`,
                `*[ NIXIE ]*

  📊 ANALYZING...
  SYSTEM CHECK ▮▮▮▮▮▮▮▮░░ 55%`,
                `*[ NIXIE ]*

  🔋 OPTIMIZING...
  SYSTEM CHECK ▮▮▮▮▮▮▮▮░░ 75%`,
                `*[ NIXIE ]*

  ✨ FINALIZING...
  SYSTEM CHECK ▮▮▮▮▮▮▮▮░░ 100%`,
                `┌─────────────────────────────┐
│  ⚡ NIXIE UPTIME REPORT ⚡   │
├─────────────────────────────┤
│ Status    → *${global.nixieOnline ? 'ONLINE ✅' : 'OFFLINE 🔴'}*            │
│ Mode      → *${mode ? '🌍 PUBLIC' : '🔒 PRIVATE'}*           │
│ Uptime    → *${uptime}*    │
│ Speed     → *⚡ ULTRA FAST*      │
│ Ping      → *~70s*             │
├─────────────────────────────┤
│ 🤖 POWERED BY NIXIE v5.0    │
└─────────────────────────────┘`
            ]
            
            if (settings.animatedResponses) {
                await sendAnimatedText(sock, chatId, frames, message, 300, settings)
            } else {
                await sendStyledMessage(sock, chatId, { text: frames[frames.length - 1] }, { quoted: message }, settings)
            }
        } catch (e) {
            await reply(`⏱️ *Uptime:* ${formatUptime(Date.now() - global.botStartTime)}`)
        }
        break
    }

    // ── MENU ────────────────────────────────────────────────
    case 'menu':
    case 'list':
    case 'help': {
        try {
            await sendLoadingReaction()
            const p = PREFIXES[0]
            const frames = [
                `*[ NIXIE ]*\n\n  ⚡ INITIALIZING SYSTEM...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮░░ 0%`,
                `*[ NIXIE ]*\n\n  🔄 PROCESSING...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮░░ 10%`,
                `*[ NIXIE ]*\n\n  🔋 ENERGIZING...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮░░ 25%`,
                `*[ NIXIE ]*\n\n  🚀 POWERING NIXIE 🤖...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮░░ 50%`,
                `*[ NIXIE ]*\n\n  🧮 CALCULATING SEQUENCE...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮░░ 75%`,
                `*[ NIXIE ]*\n\n  📥 LOADING...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮░░ 90%`,
                `*[ NIXIE ]*\n\n  ✅ SYSTEM COMPLETE...\n  CONNECTING TO SERVER ▮▮▮▮▮▮▮▮ 100%`,
                `[ *NIXIE 🤖* ]

─────────────────────────────────────────────
¦  *STATUS:* ${global.nixieOnline ? 'ONLINE ✅' : 'OFFLINE 🔴'}          ¦
¦  *MODE:* ${await DB.getMode(botNum) ? 'PUBLIC 🌍' : 'PRIVATE 🔒'}                  ¦
¦  *RUNTIME:* ${formatUptime(Date.now() - global.botStartTime)}              ¦
¦  *SPEED:* ULTRA FAST ⚡       ¦
          v5.0
────────────────────────────────────────────

────────────────────────────────────────────────
> *NIXIE CONTROL:*

────────────────────────────────────────────────
[ *NIXIE GENERAL COMMANDS* ]
────────────────────────────────────────────────
> menu  | list
> ping
> alive
> uptime
> owner
> jid
> url
> translate (lang text)
> screenshot (url)
> tts (text)
> attp (text)
> staff
> news
> groupinfo
> weather
> time
> date
> calendar
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *AI SYSTEM* ]
────────────────────────────────────────────────
> ai
> nixie
> gpt
> imagine
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *MEDIA ENGINE* ]
────────────────────────────────────────────────
> play
> ytmp3
> ytmp4
> Video
> lyrics
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *FUN CENTRE* ]
────────────────────────────────────────────────
> meme
> compliment
> insult
> flirt
> shayari
> ship
> simp
> wasted
> goodnight
> roast 
> joke 
> quote
> 8ball
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *NIXIE GAMES* ]
────────────────────────────────────────────────
> tictactoe (ttt)
> hangman
> guess
> trivia
> truth
> dare
> roll
> flip
> rps (rock,paper,scissors)
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *GROUP CONTROL* ]
────────────────────────────────────────────────
> add 
> welcome
> goodbye
> getpp
> getgpp
> tagall
> tag
> tagnotadmin
> delete > del
> leave
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *ADMIN POWER* ] 
────────────────────────────────────────────────
> mute-user
> unmute-user
> ban
> unban
> addmod
> delmod
> modlist
> kick
> promote
> demote
> lock
> unlock
> resetlink
> warn
> warnings
> setgpp
> setgname
> setgdesc
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *OWNER STRENGTH* ] 
────────────────────────────────────────────────
> mode (public | private)
> setpp
> settings
> timezone
> mention (on/off)
> setmention (reply to message)
> pmblocker (on|off|setmsg)
> vv
> setmenu (reply to image)
> font <style> 
> font list 
> font reset
> setprefix <value>
> setmode strict|smart|ai
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *TOOLS* ]
────────────────────────────────────────────────
> AntiBot
> AntiDelete
> AntiSticker
> Antilink on|off|set
> AntiGroupStatus on|off|set
> AntiBadword
> AntiCall
> AntiSpam
> AutoRead
> AntiStatus
> AutoTyping
> AutoReact
> AutoReply
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *IMAGE/STICKER COMMANDS* ]
────────────────────────────────────────────────
> sticker 
> simage 
> tovideo
> blur 
> removebg
> remini 
> emojimix 
> meme 
> take 
> crop 
> tgsticker 
> igs 
> igsc 
> insta 
> instastory 
> instareels 
> instaigtv 
> pint (Pinterest search)
> igs 
> igsc 
> insta 
> instastory 
> instareels 
> instaigtv
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *TEXTMAKER* ] eg .tm typography (your text)
────────────────────────────────────────────────
> typography <text>
> style1917 <text>
> gradienttext <text>
> freecreate <text>
> advancedglow <text>
> flag3dtext <text>
> blackpinkstyle <text>
> cartoonstyle <text>
> effectclouds <text>
> deletingtext <text>
> glitchtext <text>
> luxurygold <text>
> papercutstyle <text>
> sandsummer <text>
> summerbeach <text>
> underwatertext <text>
> writetext <text>
> neonglitch <text>
> blackpinklogo <text>
> makingneon <text>
> galaxystyle <text>
> lighteffects <text>
────────────────────────────────────────────────

────────────────────────────────────────────────
[ *MISC* ] eg .misc heart <text/url>
────────────────────────────────────────────────
> heart 
> circle 
> lgbt 
> tweet  
> namecard 
> jail 
> glass 
> triggered 
> comrade 
> passed 
> gay 
> horny 
> lolice 
> qr <text>
> barcode <text>
> shorten <url>
> expand <url>
> ip
> joke2
> advice
> cat
> dog
> meme2
> wikipedia <search>
> urban <word>
 ────────────────────────────────────────────────

────────────────────────────────────────────────
[*ANIME* ] eg .anime hug <text>
────────────────────────────────────────────────
> hug 
> kiss 
> pat 
> cry 
> wink 
> poke 
> nom 
> facepalm 
> anime <search>
> manga <search>
> character <search>
> waifu
> neko
> husbando
> foxgirl
> animequote
> animenews
> topanime
> topmanga
> seasonal
────────────────────────────────────────────────

> TYPE COMMAND TO EXECUTE...
> SYSTEM ON FIRE AND COOKING 🔥
-------------------------`
        ]      

            // Menu images: prefer per-bot saved images (one set per connected bot), then global images, then local placeholders.
            const uidSafe = (botNum || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
            const perUser = (global.MENU_IMAGES_BY_USER || {})[uidSafe]
            const MENU_IMAGES = perUser || global.MENU_IMAGES || [
                './assets/menu_images/1.jpg',
                './assets/menu_images/2.jpg',
                './assets/menu_images/3.jpg',
                './assets/menu_images/4.jpg',
                './assets/menu_images/5.jpg',
                './assets/menu_images/6.jpg',
                './assets/menu_images/7.jpg',
            ]

            const menuText = frames[frames.length - 1]
            const pick = MENU_IMAGES[Math.floor(Math.random() * MENU_IMAGES.length)]
            const imageCaption = settings.animatedResponses ? '✨ Loading Nixie menu...' : menuText

            // Send image (if available). Track whether image was sent so we don't duplicate the menu text
            let imageSent = false
            try {
                let imgRes = null
                if (String(pick).startsWith('http')) {
                    imgRes = await sendStyledMessage(sock, chatId, { image: { url: pick }, caption: imageCaption }, { quoted: message }, settings)
                } else {
                    const imgPath = require('path').resolve(pick)
                    const imgBuf = await fs.promises.readFile(imgPath)
                    imgRes = await sendStyledMessage(sock, chatId, { image: imgBuf, caption: imageCaption }, { quoted: message }, settings)
                }
                if (imgRes && imgRes.key && imgRes.key.id) imageSent = true
            } catch (e) {
                // Ignore image send failures; text animation will still send the menu.
            }

                if (settings.animatedResponses) {
                    await animateMessage(sock, chatId, frames.map(frame => formatPresentationText(frame, settings)), 200, message)
                    if (!imageSent) {
                        await sendStyledMessage(sock, chatId, menuText, { quoted: message }, settings)
                    }
                } else {
                    // If we already sent the image and used the full menu text as its caption, avoid sending the text again
                    if (!(imageSent && imageCaption === menuText)) {
                        await sendStyledMessage(sock, chatId, menuText, { quoted: message }, settings)
                    }
                }
        } catch (e) {
            await sendStyledMessage(sock, chatId, '? Failed to load menu.', { quoted: message }, settings)
        }
        break
    }

    case 'health': {
        if (!await requireOwner()) break
        try {
            const runtime = global.__nixieRuntime?.getSnapshot?.() || {}
            const mongoState = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
            const redisState = global.__redisConnected ? 'Connected' : 'Disconnected'
            const whatsappState = runtime.connectedSessions > 0 ? 'Online' : 'Offline'
            const websocketState = runtime.connectedSessions > 0 ? 'Open' : 'Closed'
            const components = [
                whatsappState === 'Online' ? null : 'WhatsApp Socket',
                websocketState === 'Open' ? null : 'WebSocket',
                mongoState === 'Connected' ? null : 'MongoDB',
                redisState === 'Connected' ? null : 'Redis',
            ].filter(Boolean)
            const summary = `🩺 *Nixie Health*

WhatsApp Socket: ${whatsappState}
WebSocket State: ${websocketState}
MongoDB: ${mongoState}
Redis: ${redisState}
Connected Sessions: ${runtime.sessionCount ?? 0}
Memory Usage: ${(runtime.memoryUsageMB ?? 0).toFixed(2)} MB
CPU Usage: ${runtime.cpuUsageUser ?? 0} / ${runtime.cpuUsageSystem ?? 0}
Uptime: ${formatUptime((runtime.uptimeSeconds ?? 0) * 1000)}
Reconnect Attempts: ${runtime.reconnectAttempts ?? 0}
Socket Count: ${runtime.socketCount ?? 0}
Listener Count: ${runtime.listenerCount ?? 0}
${components.length ? `\n⚠️ Unhealthy component(s): ${components.join(', ')}` : ''}`
            await reply(summary)
        } catch (e) {
            await reply('⚠️ Health check failed.')
        }
        break
    }

    // ── OWNER ───────────────────────────────────────────────
    case 'owner': {
        try {
            await sendLoadingReaction()
            const ownerNumberRaw = settings.ownerNumber || settings.owners?.[0]
            const ownerNumber = cleanJid(ownerNumberRaw)
            const ownerName = settings.ownerName || settings.author || 'Admin'
            const botName = settings.botName || 'NIXIE'
            const ownerDisplay = ownerNumber ? `+${ownerNumber}` : 'Not set'

            const frames = [
                `*[ NIXIE ]*

  👑 ACCESSING OWNER PROFILE...
  AUTHENTICATION ▮▮░░░░░░░░ 10%`,
                `*[ NIXIE ]*

  🔐 VERIFYING CREDENTIALS...
  AUTHENTICATION ▮▮▮▮░░░░░░ 30%`,
                `*[ NIXIE ]*

  🧬 SCANNING DATABASE...
  AUTHENTICATION ▮▮▮▮▮▮░░░░ 50%`,
                `*[ NIXIE ]*

  ⚙️ LOADING PROFILE...
  AUTHENTICATION ▮▮▮▮▮▮▮▮░░ 75%`,
                `*[ NIXIE ]*

  🎯 FINALIZING...
  AUTHENTICATION ▮▮▮▮▮▮▮▮▮▮ 100%`,
                `╔═══════════════════════════════╗
║  👑 OWNER PROFILE 👑            ║
╠═══════════════════════════════╣
║                               ║
║  Name     → *${ownerName}*
║  Role     → *KING OF NIXIE*
║  Status   → *✅ ONLINE*
║  Bot      → *${botName}*
║  Phone    → *${ownerDisplay}*
║                               ║
╠═══════════════════════════════╣
║  📱 Contact Information☝️       ║
╚═══════════════════════════════╝`
            ]

            if (settings.animatedResponses) {
                await sendAnimatedText(sock, chatId, frames, message, 300, settings)
            } else {
                await sendStyledMessage(sock, chatId, { text: frames[frames.length - 1] }, { quoted: message }, settings)
            }
        } catch (e) {
            const ownerNumberRaw = settings.ownerNumber || settings.owners?.[0]
            const ownerNumber = cleanJid(ownerNumberRaw)
            const ownerName = settings.ownerName || settings.author || 'Admin'
            const botName = settings.botName || 'NIXIE'
            const ownerDisplay = ownerNumber ? `+${ownerNumber}` : 'Not set'

            await reply(`👑 *Bot Owner*\n\nName: ${ownerName}\nPhone: ${ownerDisplay}\nBot: ${botName}`)
        }
        break
    }
    case 'jid':
        await reply(`📌 Chat: ${chatId}\n👤 Sender: ${senderId}`)
        break

    // ── GROUPINFO ───────────────────────────────────────────
    case 'groupinfo': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const meta  = await sock.groupMetadata(chatId)
        const admins = meta.participants.filter(p => p.admin)
        await reply(`📊 *Group Info*\n\nName: ${meta.subject}\nMembers: ${meta.participants.length}\nAdmins: ${admins.length}\nCreated: ${new Date(meta.creation * 1000).toLocaleDateString()}\nDescription: ${meta.desc || 'None'}`)
        break
    }

    // ── GROUP CHATBOT TOGGLE ───────────────────────────────
    case 'bot': {
        const sub = args[0]?.toLowerCase()
        const toggleChatbot = commandMeta?.chatbotToggle === true

        if (!toggleChatbot) {
            await reply('❌ Global .bot commands are disabled. Use phrases like “Nixie on” or “Assistant off” to control chat AI in groups.')
            break
        }

        if (!isGroup) {
            await reply('❌ Chatbot toggles only work in groups.')
            break
        }
        if (!await requireOwnerOrModerator()) break

        if (sub === 'on') {
            await DB.setChatbotEnabled(chatId, true)
            invalidateUserCache(chatId, senderId)
            settings.isChatbotOn = true
            await reply('✅ NIXIE AI ON for this group.')
        } else if (sub === 'off') {
            await DB.setChatbotEnabled(chatId, false)
            invalidateUserCache(chatId, senderId)
            settings.isChatbotOn = false
            await reply('🔴 NIXIE AI OFF for this group.')
        } else {
            const enabled = await DB.isChatbotEnabled(chatId)
            await reply(`NIXIE chat AI is currently: *${enabled ? 'ENABLED' : 'DISABLED'}*`)
        }
        break
    }



    // ── MODE ────────────────────────────────────────────────
    case 'mode': {
        if (!await requireOwner()) break
        const sub = args[0]?.toLowerCase()
        if (sub === 'public')  { await DB.setMode(botNum, true);  await reply('🌍 Mode: *PUBLIC* — IN PUBLIC') }
        else if (sub === 'private') { await DB.setMode(botNum, false); await reply('🔒 Mode: *PRIVATE* — IN PRIVATE MODE AND MODERATORS MODE.') }
        else { const m = await DB.getMode(botNum); await reply(`Current mode: *${m ? 'PUBLIC 🌍' : 'PRIVATE 🔒'}*\n\nUsage: ${p}mode public/private`) }
        break
    }

    // ── ANTISTATUS ─────────────────────────────────────────
    case 'antistatus': {
        await antistatusCommand(sock, chatId, message, args)
        break
    }

    // ── SETTINGS ────────────────────────────────────────────
    case 'settings': {
        if (!await requireOwner()) break

        const sub = args[0]?.toLowerCase()
        // If a specific setting is provided, allow quick toggles/updates
        if (sub) {
            const val = args[1]?.toLowerCase()
            try {
                switch (sub) {
                    case 'mode': {
                        if (val === 'public') { await DB.setMode(botNum, true); await reply('✅ Mode set to *PUBLIC*') }
                        else if (val === 'private') { await DB.setMode(botNum, false); await reply('✅ Mode set to *PRIVATE*') }
                        else { const m = await DB.getMode(botNum); await reply(`Usage: ${p}settings mode public|private\nCurrent: *${m ? 'PUBLIC' : 'PRIVATE'}*`) }
                        break
                    }
                    case 'autoreact': case 'autotype': case 'autotyping': case 'autoread': {
                        const key = sub === 'autoreact' ? 'autoreact' : (sub === 'autoread' ? 'autoread' : 'autotyping')
                        if (val === 'on') { await DB.setUserSetting(senderId, key, true); invalidateUserCache(chatId, senderId); await reply(`✅ ${key} *ON* (personal)`) }
                        else if (val === 'off') { await DB.setUserSetting(senderId, key, false); invalidateUserCache(chatId, senderId); await reply(`✅ ${key} *OFF*`) }
                        else { const cur = await DB.getUserSetting(senderId, key, false); await reply(`${key}: *${cur ? 'ON' : 'OFF'}*`) }
                        break
                    }
                    case 'pmblocker': {
                        const cur = await DB.getPmBlocker(botNum)
                        if (val === 'on') { await DB.setPmBlocker(botNum, { ...cur, enabled: true }); await reply('✅ PMBlocker *ON*') }
                        else if (val === 'off') { await DB.setPmBlocker(botNum, { ...cur, enabled: false }); await reply('✅ PMBlocker *OFF*') }
                        else { await reply(`Usage: ${p}settings pmblocker on|off\nCurrent: *${cur?.enabled ? 'ON' : 'OFF'}*`) }
                        break
                    }
                    case 'anticall': {
                        if (val === 'on') { await DB.setFeature('anticall', { enabled: true }); await reply('✅ Anticall *ON*') }
                        else if (val === 'off') { await DB.setFeature('anticall', { enabled: false }); await reply('✅ Anticall *OFF*') }
                        else { const cur = await DB.getFeature('anticall'); await reply(`Usage: ${p}settings anticall on|off\nCurrent: *${cur?.enabled ? 'ON' : 'OFF'}*`) }
                        break
                    }
                    case 'font': {
                        const opt = args[1]
                        if (!opt) { await reply(`Usage: ${p}settings font <name>`) ; break }
                        await DB.setUserSetting(senderId, 'font', opt); invalidateUserCache(chatId, senderId); await reply(`✅ Font set to *${opt}*`) 
                        break
                    }
                    case 'replystyle': {
                        const opt = args[1]
                        if (!opt) { await reply(`Usage: ${p}settings replyStyle <premium|compact|simple>`) ; break }
                        await DB.setUserSetting(senderId, 'replyStyle', opt); invalidateUserCache(chatId, senderId); await reply(`✅ ReplyStyle set to *${opt}*`) 
                        break
                    }
                    case 'timezone': {
                        // timezone auto|<Zone>|clear
                        const cur = await DB.getTimezone(botNum)
                        if (!val) {
                            await reply(`Timezone: ${cur?.tz || 'not set'}\nUse: ${p}settings timezone auto|<Zone>|clear`)
                            break
                        }
                        if (val === 'auto') {
                            // detect via Intl
                            try {
                                const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
                                if (detected) {
                                    await DB.setTimezone(botNum, { tz: detected, auto: true })
                                    await reply(`✅ Timezone auto-detected and saved: *${detected}*`)
                                } else {
                                    await reply('❌ Unable to detect timezone in this environment.')
                                }
                            } catch (e) {
                                console.error('timezone detect error', e)
                                await reply('❌ Timezone detection failed.')
                            }
                        } else if (val === 'clear') {
                            await DB.setTimezone(botNum, null)
                            await reply('✅ Timezone cleared.')
                        } else {
                            // set explicit timezone string
                            await DB.setTimezone(botNum, { tz: args[1], auto: false })
                            await reply(`✅ Timezone set to *${args[1]}*`)
                        }
                        break
                    }
                    default: {
                        await reply(`Unknown setting. Usage:\n${p}settings                — show settings\n${p}settings <option> on|off — modify\nSupported: mode, autoreact, autotyping, autoread, pmblocker, anticall, timezone, font, replystyle`)
                    }
                }
            } catch (e) {
                console.error('settings cmd error:', e?.message || e)
                await reply('❌ Failed to update setting.')
            }
            break
        }

        // No subcommand → show aggregated settings summary
        const [owners, pub, ar, at, aread, pm, ac, tz] = await Promise.all([
            DB.getOwners(),
            DB.getMode(botNum),
            DB.getUserSetting(senderId, 'autoreact', false),
            DB.getUserSetting(senderId, 'autotyping', false),
            DB.getUserSetting(senderId, 'autoread', false),
            DB.getPmBlocker(botNum),
            DB.getFeature('anticall'),
            DB.getTimezone(botNum),
        ])

        const owner = (Array.isArray(owners) && owners[0]) || (settings && settings.ownerNumber) || 'unknown'
        const out = []
        out.push('╔═════════════════════════╗')
        out.push('║   𝙽𝙸𝚇𝙸𝙴 𝙎𝙀𝚃𝚃𝙸𝙽𝙶𝚂   ║')
        out.push('╚═════════════════════════╝\n')
        out.push(`Owner: ${owner}`)
        out.push(`Mode: ${pub ? 'PUBLIC' : 'PRIVATE'}`)
        out.push(`AutoReact: ${ar ? 'ON' : 'OFF'}`)
        out.push(`AutoTyping: ${at ? 'ON' : 'OFF'}`)
        out.push(`AutoRead: ${aread ? 'ON' : 'OFF'}`)
        out.push(`Timezone: ${tz?.tz ? `${tz.tz}${tz.auto ? ' (auto)' : ''}` : 'not set'}`)
        out.push(`PMBlocker: ${pm?.enabled ? 'ON' : 'OFF'}`)
        out.push(`AntiCall: ${ac?.enabled ? 'ON' : 'OFF'}`)
        await reply(out.join('\n'))
        break
    }

    // ── FONT SYSTEM ─────────────────────────────────────────
    case 'font': {
        const option = args[0]?.toLowerCase()
        if (!option || option === 'list') {
            const lines = listFonts().map(name => `• ${name} — ${previewFont(name)}`)
            await reply(`*Font Styles*\n\n${lines.join('\n')}`)
            break
        }
        if (option === 'reset') {
            await DB.setUserSetting(senderId, 'font', 'regular')
            invalidateUserCache(chatId, senderId)
            await reply(`✅ Font reset to default.\n${previewFont('regular')}`)
            break
        }
        if (!fontExists(option)) {
            await reply(`❌ Invalid font style. Use ${p}font list to see available styles.`)
            break
        }
        await DB.setUserSetting(senderId, 'font', option)
        invalidateUserCache(chatId, senderId)
        await reply(`✅ Font set to *${option}*\nPreview:\n${previewFont(option)}`)
        break
    }


    // ── VV (view once bypass) ───────────────────────────────
    case 'vv': {
        // Use centralized viewonce command to robustly extract and forward media
        await viewonceCommand(sock, chatId, message)
        break
    }

    // ── TIMEZONE (quick command) ────────────────────────────
    case 'timezone': {
        try {
            const sub = args[0]?.toLowerCase()
            const cur = await DB.getTimezone(botNum)
            if (!sub) {
                await reply(`Timezone: ${cur?.tz || 'not set'}\nUse: ${p}timezone auto|<Zone>|clear`)
                break
            }
            if (sub === 'auto') {
                const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
                if (detected) {
                    await DB.setTimezone(botNum, { tz: detected, auto: true })
                    await reply(`✅ Timezone auto-detected and saved: *${detected}*`)
                } else {
                    await reply('❌ Unable to detect timezone in this environment.')
                }
                break
            }
            if (sub === 'clear') {
                await DB.setTimezone(botNum, null)
                await reply('✅ Timezone cleared.')
                break
            }
            // explicit tz
            await DB.setTimezone(botNum, { tz: args[0], auto: false })
            await reply(`✅ Timezone set to *${args[0]}*`)
        } catch (e) {
            console.error('timezone cmd error', e)
            await reply('❌ Timezone command failed.')
        }
        break
    }

    // ── BAN ─────────────────────────────────────────────────
    case 'ban': {
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}ban @user`); break }
        if (isGroup) {
            if (!await requireAdmin()) break
        } else if (!isOwner) { await reply('❌ Owner only in DMs!'); break }
        const added = await DB.banUser(target)
        await reply(added ? `🚫 @${target.split('@')[0]} banned!` : '⚠️ Already banned.', )
        if (added) await sendStyledMessage(sock, chatId, { text: `🚫 @${target.split('@')[0]} banned!`, mentions: [target] }, {}, settings)
        break
    }

    // ── UNBAN ───────────────────────────────────────────────
    case 'unban': {
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}unban @user`); break }
        if (isGroup) {
            const { isSenderAdmin } = await checkAdmin(sock, chatId, senderId)
            if (!isSenderAdmin && !isOwner && !isAdmin) { await reply('❌ Admins only!'); break }
        } else if (!isOwner) { await reply('❌ Owner only!'); break }
        const removed = await DB.unbanUser(target)
        await sendStyledMessage(sock, chatId, { text: removed ? `✅ @${target.split('@')[0]} unbanned!` : '⚠️ User was not banned.', mentions: [target] }, { quoted: message }, settings)
        break
    }

    // ── KICK ────────────────────────────────────────────────
    case 'kick': {
        if (!await requireAdmin()) break
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) {
            await reply(`❌ Usage: ${p}kick @user or reply to a user's message with ${p}kick`)
            break
        }

        // Use cleanJid (which keeps domain) to avoid duplicating @s.whatsapp.net
        const norm = cleanJid(target)
        const botN = cleanJid(sock.user?.id || '')
        if (norm === botN) { await reply('❌ I cannot remove myself from the group.'); break }
        if (norm === cleanJid(senderId)) { await reply('❌ You cannot kick yourself!'); break }

        try {
            const meta = await sock.groupMetadata(chatId)
            const participant = meta.participants.find(p => cleanJid(p.id) === norm)
            if (!participant) {
                await reply('❌ That user is not in this group.')
                break
            }
            if (participant.admin === 'superadmin') {
                await reply('❌ Cannot remove the group owner.')
                break
            }

            await sock.sendPresenceUpdate('composing', chatId).catch(() => {})
            await sock.groupParticipantsUpdate(chatId, [norm], 'remove')

            await sendStyledMessage(sock, chatId, { text: `✅ *Kicked*\n\nUser: @${norm.split('@')[0]}\nStatus: Removed from the group successfully.`, mentions: [norm] }, { quoted: message }, settings)
        } catch (e) {
            console.error('kick command failed:', e?.message || e)
            await reply('❌ Failed to kick the user. Make sure I am an admin and the user can be removed.')
        }
        break
    }

    // ── PROMOTE ─────────────────────────────────────────────
    case 'promote': {
        if (!await requireAdmin()) break
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}promote @user`); break }
        try {
            await sock.groupParticipantsUpdate(chatId, [target], 'promote')
            await sendStyledMessage(sock, chatId, { text: `⬆️ @${target.split('@')[0]} promoted to admin!`, mentions: [target] }, { quoted: message }, settings)
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── DEMOTE ──────────────────────────────────────────────
    case 'demote': {
        if (!await requireAdmin()) break
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}demote @user`); break }
        try {
            await sock.groupParticipantsUpdate(chatId, [target], 'demote')
            await sendStyledMessage(sock, chatId, { text: `⬇️ @${target.split('@')[0]} demoted!`, mentions: [target] }, { quoted: message }, settings)
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── MUTE-USER / UNMUTE-USER ──────────────────────────────
    case 'mute-user': {
        if (!await requireAdmin()) break
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}mute-user @user`); break }
        const done = await DB.muteUser(chatId, target)
        try { invalidateUserCache(chatId, target) } catch {}
        try {
            settings.mutedUsers = settings.mutedUsers || []
            if (done) settings.mutedUsers = Array.from(new Set([...settings.mutedUsers, target]))
        } catch {}
            await sendStyledMessage(sock, chatId, { text: done ? `🔇 @${target.split('@')[0]} muted!` : '⚠️ Already muted.', mentions: [target] }, { quoted: message }, settings)
        break
    }
    case 'unmute-user': {
        if (!await requireAdmin()) break
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}unmute-user @user`); break }
        const done = await DB.unmuteUser(chatId, target)
        try { invalidateUserCache(chatId, target) } catch {}
        try { settings.mutedUsers = (settings.mutedUsers || []).filter(u => cleanJid(u) !== target) } catch {}
        await sendStyledMessage(sock, chatId, { text: done ? `🔊 @${target.split('@')[0]} unmuted!` : '⚠️ User was not muted.', mentions: [target] }, { quoted: message }, settings)
        break
    }

    // ── WARN ────────────────────────────────────────────────
    case 'warn': {
        if (!await requireAdmin()) break
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}warn @user`); break }
        const count = await DB.addWarning(chatId, target)
        await sendStyledMessage(sock, chatId, { text: `⚠️ *WARNING*\n\n👤 @${target.split('@')[0]}\n📊 Count: ${count}/3\n🕐 ${new Date().toLocaleString()}`, mentions: [target] }, { quoted: message }, settings)
        if (count >= 3) {
            await sock.groupParticipantsUpdate(chatId, [target], 'remove').catch(() => {})
            await sendStyledMessage(sock, chatId, { text: `🚫 @${target.split('@')[0]} kicked after 3 warnings!`, mentions: [target] }, {}, settings)
            await DB.clearWarning(chatId, target)
        }
        break
    }

    // ── WARNINGS ────────────────────────────────────────────
    case 'warnings': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const rawTarget = mentioned[0] || quotedSender || senderId
        const target = normalizeTargetJid(rawTarget)
        const count  = await DB.getWarnings(chatId, target)
        await sendStyledMessage(sock, chatId, { text: `⚠️ @${target.split('@')[0]} has *${count}/3* warnings`, mentions: [target] }, { quoted: message }, settings)
        break
    }

    // ── ADDMOD / DELMOD / MODLIST ────────────────────────────
    case 'addmod': {
        if (!await requireOwner()) break
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}addmod @user`); break }
        const done = await DB.addMod(chatId, target)
        if (done) invalidateUserCache(chatId, target)
        await sendStyledMessage(sock, chatId, { text: done ? `✅ @${target.split('@')[0]} added as moderator!` : '⚠️ Already a moderator.', mentions: [target] }, { quoted: message }, settings)
        break
    }
    case 'delmod': {
        if (!await requireOwner()) break
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const rawTarget = mentioned[0] || quotedSender || args[0]
        const target = normalizeTargetJid(rawTarget)
        if (!target) { await reply(`Usage: ${p}delmod @user`); break }
        const done = await DB.removeMod(chatId, target)
        if (done) invalidateUserCache(chatId, target)
        await sendStyledMessage(sock, chatId, { text: done ? `✅ @${target.split('@')[0]} removed from moderators!` : '⚠️ Not a moderator.', mentions: [target] }, { quoted: message }, settings)
        break
    }
    case 'modlist': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const mods = await DB.getMods(chatId)
        if (!mods.length) { await reply('📋 No moderators set for this group.'); break }
        await sendStyledMessage(sock, chatId, { text: `📋 *Moderators*\n\n${mods.map((m,i) => `${i+1}. @${m.split('@')[0]}`).join('\n')}`, mentions: mods }, { quoted: message }, settings)
        break
    }

    // ── LOCK / UNLOCK ────────────────────────────────────────
    case 'lock': {
        if (!await requireAdmin()) break
        try {
            await sock.groupSettingUpdate(chatId, 'announcement')
            await reply('🔒 Group locked! Only admins can send messages.')
        } catch { await reply('❌ Failed to lock.') }
        break
    }
    case 'unlock': {
        if (!await requireAdmin()) break
        try {
            await sock.groupSettingUpdate(chatId, 'not_announcement')
            await reply('🔓 Group unlocked! Everyone can send messages.')
        } catch { await reply('❌ Failed to unlock.') }
        break
    }

    // ── DELETE ──────────────────────────────────────────────
    case 'delete':
    case 'del': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const { isSenderAdmin, isBotAdmin } = await checkAdmin(sock, chatId, senderId)
        if (!isBotAdmin) { await reply('❌ Make me an admin first!'); break }
        if (!isSenderAdmin && !isOwner && !isAdmin) { await reply('❌ Admins only!'); break }

        // If the command is issued as a reply, prefer deleting the quoted message directly.
        const ctx = message.message?.extendedTextMessage?.contextInfo || {}
        if (ctx?.stanzaId) {
            try {
                let deleteKey = null
                const stored = Array.isArray(store.messages?.[chatId]) ? store.messages[chatId].find(m => m?.key?.id === ctx.stanzaId) : null
                if (stored?.key) {
                    deleteKey = stored.key
                } else {
                    deleteKey = {
                        remoteJid: chatId,
                        id: ctx.stanzaId,
                        participant: ctx.participant,
                    }
                }

                if (deleteKey) {
                    if (deleteKey.fromMe || isBotAdmin) {
                        await sock.sendMessage(chatId, { delete: deleteKey }).catch(() => {})
                        await reply('✅ Deleted.')
                        break
                    }
                    await reply('❌ Cannot delete that message. Bot needs to be admin to delete other users messages.')
                    break
                }
            } catch (e) {
                console.error('[DEL] quoted delete failed:', e?.message || e)
            }
        }

        const countArg = args[0] ? Math.min(parseInt(args[0], 10) || 1, 50) : 1
        const chatMessages = Array.isArray(store.messages?.[chatId]) ? store.messages[chatId] : []

        // Determine target
        const targetUser = quotedSender || (mentioned[0] || null)
        const toDelete   = []

        for (let i = chatMessages.length - 1; i >= 0 && toDelete.length < countArg; i--) {
            const m = chatMessages[i]
            if (!m?.key?.id || m.key.id === message.key.id) continue
            if (targetUser) {
                if (m.key.participant === targetUser) toDelete.push(m.key)
            } else {
                if (!m.key.fromMe) toDelete.push(m.key)
            }
        }

        if (!toDelete.length) { await reply('❌ No messages found to delete.'); break }

        await reply(`🗑️ Deleting ${toDelete.length} message(s)...`)
        for (const key of toDelete) {
            await sock.sendMessage(chatId, { delete: key }).catch(() => {})
        }
        break
    }

    // ── TAGALL ──────────────────────────────────────────────
    case 'tagall': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const meta     = await sock.groupMetadata(chatId)
        const mentions = meta.participants.map(p => p.id)
        const text     = fullArgs || '📢 Attention everyone!'
        await sendStyledMessage(sock, chatId, { text: `${text}\n\n${mentions.map(m => `@${m.split('@')[0]}`).join(' ')}`, mentions }, { quoted: message }, settings)
        break
    }

    // ── TAG ─────────────────────────────────────────────────
    case 'tag': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const { isSenderAdmin } = await checkAdmin(sock, chatId, senderId)
        if (!isSenderAdmin && !isOwner && !isAdmin) { await reply('❌ Admins only!'); break }
        const meta     = await sock.groupMetadata(chatId)
        const mentions = meta.participants.map(p => p.id)
        await sendStyledMessage(sock, chatId, { text: fullArgs || '📢 Message', mentions }, { quoted: message }, settings)
        break
    }

    // ── TAGNOTADMIN ─────────────────────────────────────────
    case 'tagnotadmin': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const { isSenderAdmin } = await checkAdmin(sock, chatId, senderId)
        if (!isSenderAdmin && !isOwner && !isAdmin) { await reply('❌ Admins only!'); break }
        const meta     = await sock.groupMetadata(chatId)
        const nonAdmins = meta.participants.filter(p => !p.admin).map(p => p.id)
        if (!nonAdmins.length) { await reply('Everyone is an admin!'); break }
        await sendStyledMessage(sock, chatId, { text: `📢 Non-admins:\n${nonAdmins.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions: nonAdmins }, { quoted: message }, settings)
        break
    }

    // ── RESETLINK ───────────────────────────────────────────
    case 'resetlink': {
        if (!await requireAdmin()) break
        try {
            const code = await sock.groupRevokeInvite(chatId)
            await reply(`🔗 Link reset!\n\nhttps://chat.whatsapp.com/${code}`)
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── ADD ─────────────────────────────────────────────────
    case 'add': {
        if (!await requireAdmin()) break
        const num = fullArgs.replace(/\D/g, '')
        if (!num) { await reply(`Usage: ${p}add <phone number>`); break }
        try {
            await sock.groupParticipantsUpdate(chatId, [num + '@s.whatsapp.net'], 'add')
            await sendStyledMessage(sock, chatId, { text: `✅ Added +${num}`, mentions: [num + '@s.whatsapp.net'] }, { quoted: message }, settings)
        } catch { await reply('❌ Failed to add user.') }
        break
    }

    // ── LEAVE ───────────────────────────────────────────────
    case 'leave': {
        if (!await requireOwner()) break
        if (!isGroup) { await reply('❌ Groups only!'); break }
        await reply('👋 Left!')
        await sock.groupLeave(chatId).catch(() => {})
        break
    }

    // ── SETGNAME / SETGDESC / SETGPP ────────────────────────
    case 'setgname': {
        if (!await requireAdmin()) break
        if (!fullArgs) { await reply(`Usage: ${p}setgname <name>`); break }
        try { await sock.groupUpdateSubject(chatId, fullArgs); await reply('✅ Group name updated!') }
        catch { await reply('❌ Failed.') }
        break
    }
    case 'setgdesc': {
        if (!await requireAdmin()) break
        if (!fullArgs) { await reply(`Usage: ${p}setgdesc <description>`); break }
        try { await sock.groupUpdateDescription(chatId, fullArgs); await reply('✅ Description updated!') }
        catch { await reply('❌ Failed.') }
        break
    }
    case 'setgpp': {
        if (!await requireAdmin()) break
        const imgMsg = message.message?.imageMessage || quotedMsg?.imageMessage
        if (!imgMsg) { await reply('❌ Reply to an image!'); break }
        try {
            const s = await downloadContentFromMessage(imgMsg, 'image')
            let b   = Buffer.alloc(0); for await (const c of s) b = Buffer.concat([b,c])
            await sock.updateProfilePicture(chatId, b)
            await reply('✅ Group picture updated!')
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── SETPP ───────────────────────────────────────────────
    case 'setpp': {
        if (!await requireOwner()) break
        const imgMsg = message.message?.imageMessage || quotedMsg?.imageMessage
        if (!imgMsg) { await reply('❌ Reply to an image!'); break }
        try {
            const s = await downloadContentFromMessage(imgMsg, 'image')
            let b   = Buffer.alloc(0); for await (const c of s) b = Buffer.concat([b,c])
            await sock.updateProfilePicture(sock.user.id, b)
            await reply('✅ Profile picture updated!')
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── SETMENU (save images for .menu random picker) ─────────────────
    case 'setmenu': {
        // Accept either: reply to a message with multiple images, or send images and run this command
        const imgs = []
        // If quoted message has media, try to extract in several shapes
        const ctx = message.message?.extendedTextMessage?.contextInfo || {}
        const qmsg = ctx?.quotedMessage || quotedMsg || null
        if (qmsg) {
            if (qmsg.imageMessage) imgs.push(qmsg.imageMessage)
            if (qmsg.videoMessage) imgs.push(qmsg.videoMessage)
            if (qmsg.documentMessage && (qmsg.documentMessage.mimetype || '').startsWith('image')) imgs.push(qmsg.documentMessage)
            if (qmsg.ephemeralMessage?.message) {
                const em = qmsg.ephemeralMessage.message
                if (em.imageMessage) imgs.push(em.imageMessage)
                if (em.videoMessage) imgs.push(em.videoMessage)
            }
        }

        // Fallback: attempt to find original quoted message from the in-memory store by stanzaId
        if (ctx?.stanzaId && Array.isArray(store.messages?.[chatId])) {
            const orig = store.messages[chatId].find(m => m?.key?.id === ctx.stanzaId)
            if (orig?.message?.imageMessage) imgs.push(orig.message.imageMessage)
            if (orig?.message?.videoMessage) imgs.push(orig.message.videoMessage)
        }

        // Also include current message image if any
        if (message.message?.imageMessage) imgs.push(message.message.imageMessage)

        if (!imgs.length) { await reply('❌ Reply to one or more images with this command.'); break }

        try {
            const path = require('path')
            // Save images per connected bot account (botNum) so each bot keeps its own menu images
            const uidSafe = (botNum || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
            const saveDir = path.resolve(`./assets/menu_images/${uidSafe}`)
            await fs.promises.mkdir(saveDir, { recursive: true })

            const saved = []
            let idx = 1
            for (const im of imgs) {
                const stream = await downloadContentFromMessage(im, 'image')
                let buf = Buffer.alloc(0)
                for await (const c of stream) buf = Buffer.concat([buf, c])
                const out = path.join(saveDir, `${idx}.jpg`)
                await fs.promises.writeFile(out, buf)
                saved.push(out)
                idx++
            }

            // set per-user global array for runtime
            global.MENU_IMAGES_BY_USER = global.MENU_IMAGES_BY_USER || {}
            global.MENU_IMAGES_BY_USER[uidSafe] = saved
            await reply(`✅ Saved ${saved.length} menu image(s) for your BOT! Use your prefix to preview.`)
        } catch (e) {
            console.error(e)
            await reply('❌ Failed to save images.')
        }
        break
    }

    // ── GETPP / GETGPP ──────────────────────────────────────
    case 'getpp': {
        const target = mentioned[0] || quotedSender || senderId
        try {
            const pp = await sock.profilePictureUrl(target, 'image')
            await sendStyledMessage(sock, chatId, { image: { url: pp }, caption: `@${target.split('@')[0]}`, mentions: [target] }, { quoted: message }, settings)
        } catch { await reply('❌ No profile picture.') }
        break
    }
    case 'getgpp': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        try {
            const pp   = await sock.profilePictureUrl(chatId, 'image')
            const meta = await sock.groupMetadata(chatId)
            await sendStyledMessage(sock, chatId, { image: { url: pp }, caption: `📷 ${meta.subject}` }, { quoted: message }, settings)
        } catch { await reply('❌ No group picture.') }
        break
    }

    // ── STAFF / ADMINS ──────────────────────────────────────
    case 'staff':
    case 'admins': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        const meta   = await sock.groupMetadata(chatId)
        const admins = meta.participants.filter(p => p.admin)
        const list   = admins.map((a, i) => `${i+1}. @${a.id.split('@')[0]}`).join('\n')
        await sendStyledMessage(sock, chatId, { text: `👑 *Group Admins - ${meta.subject}*\n\n${list}`, mentions: admins.map(a => a.id) }, { quoted: message }, settings)
        break
    }

    // ── WELCOME / GOODBYE ────────────────────────────────────
    case 'welcome': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('welcome')) break
        const sub = args[0]?.toLowerCase()
        if (!['on','off'].includes(sub)) { await reply(`Usage: ${p}welcome on/off`); break }
        await DB.setWelcome(chatId, sub === 'on')
        await reply(`✅ Welcome messages *${sub.toUpperCase()}*`)
        break
    }
    case 'goodbye': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('goodbye')) break
        const sub = args[0]?.toLowerCase()
        if (!['on','off'].includes(sub)) { await reply(`Usage: ${p}goodbye on/off`); break }
        await DB.setGoodbye(chatId, sub === 'on')
        await reply(`✅ Goodbye messages *${sub.toUpperCase()}*`)
        break
    }

    // ── ANTILINK ────────────────────────────────────────────
    case 'antilink': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('antilink')) break
        const sub  = args[0]?.toLowerCase()
        const cur  = await DB.getAntilink(chatId)
        if (sub === 'on')  { await DB.setAntilink(chatId, { ...cur, enabled: true }); await reply('✅ Antilink *ON*') }
        else if (sub === 'off') { await DB.setAntilink(chatId, { ...cur, enabled: false }); await reply('✅ Antilink *OFF*') }
        else if (sub === 'set') {
            const action = args[1]?.toLowerCase()
            if (!/^delete$|^kick$|^warn(?:\(\d+\))?$/.test(action)) { await reply(`Usage: ${p}antilink set delete|kick|warn(n)`); break }
            await DB.setAntilink(chatId, { ...cur, action }); await reply(`✅ Antilink action set to *${action}*`)
        } else {
            await reply(hackerBox(`[ ANTILINK ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}\nAction: ${cur.action || 'delete'}`))
        }
        break
    }

    // ── ANTIBADWORD ─────────────────────────────────────────
    case 'antibadword': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('antibadword')) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getAntibadword(chatId)
        if (sub === 'on')  { await DB.setAntibadword(chatId, { ...cur, enabled: true }); await reply('✅ Antibadword *ON*') }
        else if (sub === 'off') { await DB.setAntibadword(chatId, { ...cur, enabled: false }); await reply('✅ Antibadword *OFF*') }
        else if (sub === 'set') {
            const action = args[1]?.toLowerCase()
            if (!/^delete$|^kick$|^warn(?:\(\d+\))?$/.test(action)) { await reply(`Usage: ${p}antibadword set delete|kick|warn(n)`); break }
            await DB.setAntibadword(chatId, { ...cur, action }); await reply(`✅ Antibadword action set to *${action}*`)
        } else if (sub === 'add') {
            const word = args[1]?.toLowerCase()
            if (!word) { await reply(`Usage: ${p}antibadword add <word>`); break }
            cur.words = [...new Set([...(cur.words||[]), word])]
            await DB.setAntibadword(chatId, cur); await reply(`✅ Added "*${word}*" to bad words list.`)
        } else if (sub === 'remove') {
            const word = args[1]?.toLowerCase()
            cur.words = (cur.words||[]).filter(w => w !== word)
            await DB.setAntibadword(chatId, cur); await reply(`✅ Removed "*${word}*"`)
        } else if (sub === 'list') {
            await reply(cur.words?.length ? `📋 Bad words:\n${cur.words.join(', ')}` : 'No bad words set.')
        } else {
            await reply(hackerBox(`[ ANTIBADWORD ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}\nWords: ${cur.words?.length || 0}\nAction: ${cur.action || 'delete'}`))
        }
        break
    }

    // ── ANTISPAM ────────────────────────────────────────────
    case 'antispam': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('antispam')) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getGroupSetting(chatId, 'antispam') || {}
        if (sub === 'on')  { await DB.setGroupSetting(chatId, 'antispam', { ...cur, enabled: true }); await reply('✅ Antispam *ON*') }
        else if (sub === 'off') { await DB.setGroupSetting(chatId, 'antispam', { ...cur, enabled: false }); await reply('✅ Antispam *OFF*') }
        else if (sub === 'set') {
            const action = args[1]?.toLowerCase()
            if (!/^delete$|^kick$|^warn(?:\(\d+\))?$/.test(action)) { await reply(`Usage: ${p}antispam set delete|kick|warn(n)`); break }
            await DB.setGroupSetting(chatId, 'antispam', { ...cur, action }); await reply(`✅ Antispam action set to *${action}*`)
        } else { await reply(hackerBox(`[ ANTISPAM ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}\nAction: ${cur.action || 'delete'}`)) }
        break
    }

    // ── ANTIDELETE ──────────────────────────────────────────
    case 'antidelete': {
        if (!await requireOwner()) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getAntidelete()
        if (sub === 'on')  { await DB.setAntidelete({ enabled: true }); await reply('✅ Antidelete *ON*') }
        else if (sub === 'off') { await DB.setAntidelete({ enabled: false }); await reply('✅ Antidelete *OFF*') }
        else { await reply(hackerBox(`[ ANTIDELETE ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}`)) }
        break
    }

    // ── ANTIBOT ─────────────────────────────────────────────
    case 'antibot': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('antibot')) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getGroupSetting(chatId, 'antibot') || {}
        if (sub === 'on')  { await DB.setGroupSetting(chatId, 'antibot', { ...cur, enabled: true }); await reply('✅ Antibot *ON*') }
        else if (sub === 'off') { await DB.setGroupSetting(chatId, 'antibot', { ...cur, enabled: false }); await reply('✅ Antibot *OFF*') }
        else if (sub === 'set') {
            const action = args[1]?.toLowerCase()
            if (!/^kick$|^warn$/.test(action)) { await reply(`Usage: ${p}antibot set kick|warn`); break }
            await DB.setGroupSetting(chatId, 'antibot', { ...cur, action }); await reply(`✅ Antibot action set to *${action}*`)
        } else {
            await reply(hackerBox(`[ ANTIBOT ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}\nAction: ${cur.action || 'kick'}`))
        }
        break
    }

    // ── ANTISTICKER ─────────────────────────────────────────
    case 'antisticker': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        if (!await requireGroupSettingPermission('antisticker')) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getGroupSetting(chatId, 'antisticker') || {}
        if (sub === 'on')  { await DB.setGroupSetting(chatId, 'antisticker', { ...cur, enabled: true }); invalidateUserCache(chatId, senderId); await reply('✅ Antisticker *ON*') }
        else if (sub === 'off') { await DB.setGroupSetting(chatId, 'antisticker', { ...cur, enabled: false }); invalidateUserCache(chatId, senderId); await reply('✅ Antisticker *OFF*') }
        else if (sub === 'set') {
            const action = args[1]?.toLowerCase()
            if (!/^delete$|^kick$|^warn(?:\(\d+\))?$/.test(action)) { await reply(`Usage: ${p}antisticker set delete|kick|warn(n)`); break }
            await DB.setGroupSetting(chatId, 'antisticker', { ...cur, action }); invalidateUserCache(chatId, senderId); await reply(`✅ Antisticker action set to *${action}*`)
        } else { await reply(hackerBox(`[ ANTISTICKER ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}\nAction: ${cur.action || 'delete'}`)) }
        break
    }

    // ── ANTICALL ────────────────────────────────────────────
    case 'anticall': {
        if (!await requireOwner()) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getFeature('anticall')
        if (sub === 'on')  { await DB.setFeature('anticall', { enabled: true }); await reply('✅ Anticall *ON*') }
        else if (sub === 'off') { await DB.setFeature('anticall', { enabled: false }); await reply('✅ Anticall *OFF*') }
        else { await reply(hackerBox(`[ ANTICALL ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}`)) }
        break
    }

    // ── AUTOREACT / AUTOREAD / AUTOTYPING ────────────────────
    case 'autoreact': {
        const sub = args[0]?.toLowerCase()
        if (sub === 'on')  { await DB.setUserSetting(senderId, 'autoreact', true); await reply('✅ AutoReact *ON* (personal)') }
        else if (sub === 'off') { await DB.setUserSetting(senderId, 'autoreact', false); await reply('✅ AutoReact *OFF*') }
        else { const cur = await DB.getUserSetting(senderId, 'autoreact', false); await reply(`AutoReact: *${cur ? 'ON' : 'OFF'}*`) }
        break
    }
    case 'autoread': {
        const sub = args[0]?.toLowerCase()
        if (sub === 'on')  { await DB.setUserSetting(senderId, 'autoread', true); await reply('✅ AutoRead *ON* (personal)') }
        else if (sub === 'off') { await DB.setUserSetting(senderId, 'autoread', false); await reply('✅ AutoRead *OFF*') }
        else { const cur = await DB.getUserSetting(senderId, 'autoread', false); await reply(`AutoRead: *${cur ? 'ON' : 'OFF'}*`) }
        break
    }
    case 'autotyping':
    case 'autotype': {
        const sub = args[0]?.toLowerCase()
        if (sub === 'on')  { await DB.setUserSetting(senderId, 'autotyping', true); await reply('✅ AutoTyping *ON* (personal)') }
        else if (sub === 'off') { await DB.setUserSetting(senderId, 'autotyping', false); await reply('✅ AutoTyping *OFF*') }
        else { const cur = await DB.getUserSetting(senderId, 'autotyping', false); await reply(`AutoTyping: *${cur ? 'ON' : 'OFF'}*`) }
        break
    }

    // ── AUTOREPLY ───────────────────────────────────────────
    case 'autoreply': {
        if (!await requireOwner()) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getAutoreply(botNum)
        if (sub === 'on')  { await DB.setAutoreply(botNum, { ...cur, enabled: true }); await reply('✅ AutoReply *ON*') }
        else if (sub === 'off') { await DB.setAutoreply(botNum, { ...cur, enabled: false }); await reply('✅ AutoReply *OFF*') }
        else if (sub === 'set') {
            const replyText = args.slice(1).join(' ').trim()
            if (!replyText) { await reply(`Usage: ${p}autoreply set <message>`); break }
            await DB.setAutoreply(botNum, { ...cur, enabled: true, replyText });
            await reply(`✅ AutoReply message set.`)
        } else if (sub === 'clear') {
            const next = { ...cur }
            delete next.replyText
            await DB.setAutoreply(botNum, next)
            await reply('✅ AutoReply message cleared.')
        } else if (sub === 'add') {
            const trigger = args[1]?.toLowerCase()
            const resp    = args.slice(2).join(' ')
            if (!trigger || !resp) { await reply(`Usage: ${p}autoreply add <trigger> <response>`); break }
            cur.replies = cur.replies || {}
            cur.replies[trigger] = resp
            await DB.setAutoreply(botNum, cur); await reply(`✅ AutoReply added: *${trigger}* → ${resp}`)
        } else if (sub === 'remove') {
            const trigger = args[1]?.toLowerCase()
            if (!trigger) { await reply(`Usage: ${p}autoreply remove <trigger>`); break }
            delete (cur.replies || {})[trigger]
            await DB.setAutoreply(botNum, cur); await reply(`✅ Removed trigger *${trigger}*`)
        } else if (sub === 'list') {
            const list = []
            if (cur.replyText) list.push(`• default reply: ${cur.replyText}`)
            const keys = Object.keys(cur.replies || {})
            for (const k of keys) list.push(`• ${k} → ${cur.replies[k]}`)
            await reply(list.length ? `📋 AutoReplies:\n${list.join('\n')}` : 'No auto-replies set.')
        } else {
            await reply(hackerBox(`[ AUTOREPLY ]\n\nStatus: ${cur.enabled ? 'ON' : 'OFF'}\nDefault Reply: ${cur.replyText ? 'SET' : 'NONE'}\nTriggers: ${Object.keys(cur.replies||{}).length}`))
        }
        break
    }

    // ── PMBLOCKER ───────────────────────────────────────────
    case 'pmblocker': {
        if (!await requireOwner()) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getPmBlocker(botNum)
        if (sub === 'on')  { await DB.setPmBlocker(botNum, { ...cur, enabled: true }); await reply('✅ PMBlocker *ON*') }
        else if (sub === 'off') { await DB.setPmBlocker(botNum, { ...cur, enabled: false }); await reply('✅ PMBlocker *OFF*') }
        else if (sub === 'setmsg') {
            const msg = args.slice(1).join(' ')
            if (!msg) { await reply(`Usage: ${p}pmblocker setmsg <message>`); break }
            await DB.setPmBlocker(botNum, { ...cur, message: msg }); await reply('✅ PM block message set!')
        } else {
            await reply(`PMBlocker: *${cur.enabled ? 'ON' : 'OFF'}*\nMessage: ${cur.message || 'Default'}`)
        }
        break
    }

    // ── MENTION ─────────────────────────────────────────────
    case 'mention': {
        if (!await requireOwner()) break
        const sub = args[0]?.toLowerCase()
        const cur = await DB.getMentionReply(botNum)
        if (sub === 'on')  { await DB.setMentionReply(botNum, { ...cur, enabled: true }); await reply('✅ Mention reply *ON*') }
        else if (sub === 'off') { await DB.setMentionReply(botNum, { ...cur, enabled: false }); await reply('✅ Mention reply *OFF*') }
        else { await reply(`Mention Reply: *${cur.enabled ? 'ON' : 'OFF'}*\nMessage: ${cur.message || 'Not set'}`) }
        break
    }
    case 'setmention': {
        if (!await requireOwner()) break
        if (!quotedMsg) { await reply('❌ Reply to a message!'); break }
        const text = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || ''
        if (!text) { await reply('❌ Quoted message has no text!'); break }
        const cur = await DB.getMentionReply(botNum)
        await DB.setMentionReply(botNum, { ...cur, message: text })
        await reply('✅ Mention reply message set!')
        break
    }
    case 'setprefix': {
        const newPrefix = fullArgs
        if (newPrefix === '') {
            await DB.setUserSetting(senderId, 'prefix', '')
            invalidateUserCache(chatId, senderId)
            await reply('✅ Prefix set to empty string. You can now send commands without a prefix.')
            break
        }
        await DB.setUserSetting(senderId, 'prefix', newPrefix)
        invalidateUserCache(chatId, senderId)
        await reply(`✅ Prefix updated to: ${newPrefix}`)
        break
    }
    case 'setmode': {
        const mode = (args[0] || '').toLowerCase()
        if (!['strict', 'smart', 'ai'].includes(mode)) {
            await reply(`Usage: ${p}setmode strict|smart|ai\nCurrent mode: ${settings.userMode || 'strict'}`)
            break
        }
        await DB.setUserSetting(senderId, 'mode', mode)
        invalidateUserCache(chatId, senderId)
        await reply(`✅ Mode updated to: ${mode}`)
        break
    }

    // ── AI COMMANDS ─────────────────────────────────────────
    case 'ai':
    case 'gpt':
    case 'nixie': {
        // Delegate to modular AI command handler. It uses safe timeouts and fallbacks.
        try {
            await aiCommand(sock, message, chatId, fullArgs, reply)
        } catch (e) {
            console.error('AI handler failed:', e?.message || e)
            await reply('❌ Failed to get AI response.\nPlease try again later.')
        }
        break
    }

    // ── IMAGE SEARCH ─────────────────────────────────────────
    case 'image': {
        const query = fullArgs.trim()
        if (!query) {
            await reply('❌ Please provide a search query. Example: .image car')
            break
        }
        if (!UNSPLASH_ACCESS_KEY) {
            await reply('❌ Image search unavailable. Missing Unsplash API key.')
            break
        }
        try {
            await sendLoadingReaction()
        } catch {}
        try {
            const imageUrl = await searchUnsplashImage(query)
            if (!imageUrl) {
                await reply('❌ No images found')
                break
            }
            await reply(`📷 ${imageUrl}`)
        } catch (err) {
            console.error('Unsplash image search failed:', err?.message || err)
            await reply('❌ Failed to fetch images. Please try again later.')
        }
        break
    }

    // ── IMAGINE (offloaded to worker) ────────────────────────
    case 'imagine':
    case 'flux':
    case 'aiimage': {
        try {
            // send immediate feedback
            try { await sendStyledMessage(sock, chatId, '🎨 Generating your image...', { quoted: message }, settings) } catch {}
            const workerPool = require('./lib/workerPool')
            const resp = await workerPool.runTask('imagine', { prompt: fullArgs || '' })
                if (resp && resp.type === 'base64') {
                    const buf = Buffer.from(resp.data, 'base64')
                    await sendStyledMessage(sock, chatId, { image: buf, caption: '🎨 Generated Image' }, { quoted: message }, settings)
                } else {
                // fallback to in-process handler
                await imagineCommand(sock, message, chatId, fullArgs, reply)
            }
        } catch (err) {
            console.error('Imagine (worker) failed:', err?.message || err)
            try { await imagineCommand(sock, message, chatId, fullArgs, reply) } catch (e) { await reply('❌ Failed to generate image.\nPlease try again later.') }
        }
        break
    }

    // ── SORA ────────────────────────────────────────────────
    case 'sora':
    case 'aivideo': {
        // Route video/variant aliases to the same imagine flow for now
        try {
            await imagineCommand(sock, message, chatId, fullArgs, reply)
        } catch (err) {
            console.error('Imagine (alias) handler failed:', err?.message || err)
            await reply('❌ Failed to generate image/video. Please try again later.')
        }
        break
    }

    // ── STICKER ─────────────────────────────────────────────
    case 'sticker':
    case 'tosticker':
    case 's':
    case 'simage': {
        const quoted = quotedMsg || message.message?.imageMessage || message.message?.videoMessage || message.message?.stickerMessage || message.message?.documentMessage
        const qMsg = quotedMsg || message.message
        // Determine quoted type
        const quotedType = quotedMsg?.mtype || (message.message?.imageMessage && 'imageMessage') || (message.message?.videoMessage && 'videoMessage') || null
        const isImage = quotedType === 'imageMessage' || Boolean(message.message?.imageMessage)
        const isVideo = quotedType === 'videoMessage' || Boolean(message.message?.videoMessage)

        if (!quotedMsg && !isImage && !isVideo) {
            await reply(`❌ Reply to an image or short video/GIF with ${p}sticker`)
            break
        }

        await reply('⚙️ Converting to sticker...')
        try {
            const stickers = require('./lib/stickers')
            // If image path
            if (isImage) {
                const stream = await downloadContentFromMessage(quotedMsg?.imageMessage || message.message.imageMessage, 'image')
                let b = Buffer.alloc(0)
                for await (const chunk of stream) b = Buffer.concat([b, chunk])
                const stickerBuffer = await stickers.imageToSticker(b)
                await sock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: message })
                break
            }

            // Video/GIF path
            if (!stickers.isAnimatedStickerSupported()) {
                await reply("❌ Animated stickers aren't available yet on this deployment.--try replying to a photo instead!")
                break
            }

            const durationSec = quotedMsg?.seconds || message.message?.videoMessage?.seconds || 0
            if (durationSec > 10) {
                await reply('❌ Video too long for a sticker. Keep it under 10 seconds.')
                break
            }

            const stream = await downloadContentFromMessage(quotedMsg?.videoMessage || message.message.videoMessage, 'video')
            let vb = Buffer.alloc(0)
            for await (const chunk of stream) vb = Buffer.concat([vb, chunk])
            const animatedBuffer = await stickers.videoToAnimatedSticker(vb, Math.min(durationSec || 6, 6))
            await sock.sendMessage(chatId, { sticker: animatedBuffer }, { quoted: message })
        } catch (err) {
            console.error('Sticker error:', err?.message || err)
            if (err?.message === 'ANIMATED_STICKERS_NOT_INSTALLED') {
                await reply("❌ Animated stickers Failed!.")
            } else {
                await reply('❌ Failed to create sticker. Try a different image/video.')
            }
        }
        break
    }

    // ── ATTP (Animated Text-to-Picture) ─────────────────────
    case 'attp': {
        try {
            const text = fullArgs?.trim()

            if (!text) {
                return reply(`╭━━〔 ATTP STICKER 〕━━⬣
┃ Example:
┃ .attp Hello
╰━━━━━━━━━━━━⬣`)
            }

            await sock.sendMessage(chatId, {
                react: { text: '🎨', key: message.key }
            })

            const apis = [
                `https://api.xteam.xyz/attp?file&text=${encodeURIComponent(text)}`,
                `https://api.popcat.xyz/attp?text=${encodeURIComponent(text)}`,
                `https://botcahx.ddns.net/api/attp?text=${encodeURIComponent(text)}`
            ]

            let stickerBuffer = null
            for (const api of apis) {
                try {
                    const res = await axios.get(api, { responseType: 'arraybuffer', timeout: 10000 })
                    if (res.data && res.data.length > 0) {
                        stickerBuffer = Buffer.from(res.data)
                        break
                    }
                } catch (e) {
                    continue
                }
            }

            if (!stickerBuffer) {
                return reply('❌ NIXIE ATTP failed. Try again later.')
            }

            await sock.sendMessage(chatId, {
                sticker: stickerBuffer
            }, { quoted: message })

        } catch (err) {
            console.log(err)
            reply('❌ NIXIE ATTP failed. Try again later.')
        }
        break
    }

    // ── TTS (Text-to-Speech) ────────────────────────────────
    // ── URL (upload image to telegraph) ─────────────────────
    case 'url': {
        const imgMsg = message.message?.imageMessage || quotedMsg?.imageMessage
        if (!imgMsg) { await reply(`Usage: Reply to an image with ${p}url`); break }
        try {
            const s = await downloadContentFromMessage(imgMsg, 'image')
            let b   = Buffer.alloc(0); for await (const c of s) b = Buffer.concat([b,c])
            const FormData = require('form-data')
            const form     = new FormData()
            form.append('file', b, { filename: 'image.jpg', contentType: 'image/jpeg' })
            const res = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders() })
            await reply(`🔗 https://telegra.ph${res.data[0]?.src}`)
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── BLUR (offloaded to worker) ───────────────────────────
    case 'blur': {
        const imgMsg = message.message?.imageMessage || quotedMsg?.imageMessage
        if (!imgMsg) { await reply('❌ Reply to an image!'); break }
        await reply('⚙️ Blurring...')
        try {
            const s = await downloadContentFromMessage(imgMsg, 'image')
            let b   = Buffer.alloc(0); for await (const c of s) b = Buffer.concat([b,c])
            const workerPool = require('./lib/workerPool')
            const resp = await workerPool.runTask('blur', { imageBase64: b.toString('base64') })
            if (resp && resp.type === 'base64') {
                const out = Buffer.from(resp.data, 'base64')
                await sendStyledMessage(sock, chatId, { image: out, caption: '✅ Blurred!' }, { quoted: message }, settings)
            } else {
                const sharp = require('sharp')
                const blurred = await sharp(b).blur(10).toBuffer()
                await sendStyledMessage(sock, chatId, { image: blurred, caption: '✅ Blurred!' }, { quoted: message }, settings)
            }
        } catch (e) {
            console.error('blur worker failed:', e?.message || e)
            await reply('❌ Failed.')
        }
        break
    }

    // ── TOVIDEO (Convert sticker/audio to mp4) ──────────────
    case 'tovideo':
    case 'svideo': {
        try {
            const { webp2mp4 } = require('./lib/webp2mp4')
            const { ffmpeg } = require('./lib/converter')

            if (!quotedMsg) { await reply(`Usage: Reply to a sticker or audio with ${p}tovideo`); break }
            const mime = quotedMsg?.mimetype || quotedMsg?.imageMessage?.mimetype || quotedMsg?.stickerMessage?.mimetype || quotedMsg?.audioMessage?.mimetype || quotedMsg?.documentMessage?.mimetype || ''
            if (!mime) { await reply('❌ Unsupported quoted message. Reply to a sticker or audio.'); break }

            const workerPool = require('./lib/workerPool')

            // If sticker (webp) -> convert to mp4
            if (/webp/.test(mime) || quotedMsg?.stickerMessage) {
                const media = quotedMsg.stickerMessage || quotedMsg.imageMessage || quotedMsg
                const stream = await downloadContentFromMessage(media, 'sticker')
                let buf = Buffer.alloc(0)
                for await (const c of stream) buf = Buffer.concat([buf, c])
                if (!buf || buf.length === 0) return reply('❌ Failed to download sticker')
                try {
                    const resp = await workerPool.runTask('webp2mp4', { imageBase64: buf.toString('base64') })
                    if (!resp || resp.type !== 'base64') throw new Error('worker conversion failed')
                    const mp4 = Buffer.from(resp.data, 'base64')
                    await sock.sendMessage(chatId, { video: mp4, mimetype: 'video/mp4', fileName: 'tovideo.mp4' }, { quoted: message })
                } catch (e) {
                    console.error('[tovideo] webp2mp4 failed:', e?.message || e)
                    await reply('❌ Conversion failed. Ensure ffmpeg is installed or available on PATH.')
                }
                break
            }

            // If audio -> wrap into simple mp4 container
            if (/audio|ogg|mp3|m4a/.test(mime)) {
                const media = quotedMsg.audioMessage || quotedMsg
                const stream = await downloadContentFromMessage(media, 'audio')
                let buf = Buffer.alloc(0)
                for await (const c of stream) buf = Buffer.concat([buf, c])
                if (!buf || buf.length === 0) return reply('❌ Failed to download audio')
                try {
                    const resp = await workerPool.runTask('audio2mp4', { audioBase64: buf.toString('base64') })
                    if (!resp || resp.type !== 'base64') throw new Error('worker conversion failed')
                    const out = Buffer.from(resp.data, 'base64')
                    await sock.sendMessage(chatId, { video: out, mimetype: 'video/mp4', fileName: 'tovideo.mp4' }, { quoted: message })
                } catch (e) {
                    console.error('[tovideo] audio->mp4 failed:', e?.message || e)
                    await reply('❌ Conversion failed. Ensure ffmpeg is installed or available on PATH.')
                }
                break
            }

            await reply('❌ Unsupported media for conversion.')
        } catch (err) {
            console.error('[tovideo] handler error:', err?.message || err)
            await reply('❌ tovideo failed. Ensure ffmpeg is installed or available on PATH.')
        }
        break
    }

    // ── REMOVEBG (offloaded to worker) ───────────────────────
    case 'removebg':
    case 'rmbg': {
        const imgMsg = message.message?.imageMessage || quotedMsg?.imageMessage
        if (!imgMsg) { await reply('❌ Reply to an image!'); break }
        await reply('⚙️ Removing background...')
        try {
            const s = await downloadContentFromMessage(imgMsg, 'image')
            let b   = Buffer.alloc(0); for await (const c of s) b = Buffer.concat([b,c])
            const workerPool = require('./lib/workerPool')
            const resp = await workerPool.runTask('removebg', { imageBase64: b.toString('base64') })
                if (resp && resp.type === 'base64') {
                    const out = Buffer.from(resp.data, 'base64')
                    await sendStyledMessage(sock, chatId, { image: out, caption: '✅ Background removed!' }, { quoted: message }, settings)
                } else {
                await reply('❌ Failed to remove background.')
            }
        } catch (e) {
            console.error('removebg worker failed:', e?.message || e)
            await reply('❌ Failed to remove background.')
        }
        break
    }

    // ── SCREENSHOT ──────────────────────────────────────────
    case 'ss':
    case 'screenshot': {
        if (!fullArgs?.startsWith('http')) { await reply(`Usage: ${p}ss <url>`); break }
        await reply('📸 Taking screenshot...')
        try {
            const res = await axios.get(`https://api.siputzx.my.id/api/tools/ssweb?url=${encodeURIComponent(fullArgs)}&theme=light&device=desktop`, { responseType: 'arraybuffer', timeout: 30_000 })
            await sendStyledMessage(sock, chatId, { image: Buffer.from(res.data) }, { quoted: message }, settings)
        } catch { await reply('❌ Failed.') }
        break
    }

    // ── TRANSLATE ───────────────────────────────────────────
    case 'translate':
    case 'trt': {
        let lang = '', text = ''
        if (quotedMsg) {
            text = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || ''
            lang = fullArgs.trim()
        } else {
            const parts = fullArgs.trim().split(' ')
            lang = parts[0]; text = parts.slice(1).join(' ')
        }
        if (!lang || !text) { await reply(`Usage: ${p}trt <lang> <text>\nExample: ${p}trt es Hello world`); break }
        try {
            const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`, { timeout: 10_000 })
            const translated = res.data?.[0]?.[0]?.[0]
            if (!translated) throw new Error('no translation')
            await reply(`🌐 *Translation*\n\n📝 Original: ${text}\n🔄 To: ${lang}\n✅ Result: ${translated}`)
        } catch { await reply('❌ Translation failed.') }
        break
    }

    // ── TTS ─────────────────────────────────────────────────
    case 'tts': {
        if (!fullArgs) { await reply(`Usage: ${p}tts <text>`); break }
        try {
            await reply('🔊 Converting to speech...')

            const text = fullArgs.trim()
            const encodedText = encodeURIComponent(text)

            // Try multiple TTS APIs
            const ttsApis = [
                // Google Translate TTS (primary)
                {
                    url: `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=en&client=tw-ob`,
                    mimetype: 'audio/mpeg'
                },
                // Picospeaker fallback
                {
                    url: `https://picospeaker.ri.mu/?text=${encodedText}`,
                    mimetype: 'audio/wav'
                }
            ]

            let audioBuffer = null
            let workingMimetype = 'audio/mpeg'

            for (const api of ttsApis) {
                try {
                    const res = await axios.get(api.url, {
                        responseType: 'arraybuffer',
                        timeout: 15000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0'
                        }
                    })

                    if (res.data && res.data.length > 100) { // Ensure we got valid audio data
                        audioBuffer = res.data
                        workingMimetype = api.mimetype
                        break
                    }
                } catch (e) {
                    console.error(`[tts] API failed: ${api.url}`, e.message)
                    continue
                }
            }

            // If online APIs fail, try local gtts
            if (!audioBuffer) {
                try {
                    const gTTS = require('gtts')
                    const tmpFile = path.join(TEMP_MEDIA_DIR, `tts-${Date.now()}.mp3`)
                    await new Promise((res, rej) => new gTTS(text, 'en').save(tmpFile, e => e ? rej(e) : res()))
                    audioBuffer = await fs.promises.readFile(tmpFile)
                    workingMimetype = 'audio/mpeg'
                    await fs.promises.unlink(tmpFile)
                } catch (e) {
                    console.error('[tts] gtts failed:', e.message)
                }
            }

            if (!audioBuffer) {
                return reply('❌ All TTS services failed. Try again later.')
            }

            await sock.sendMessage(chatId, {
                audio: audioBuffer,
                mimetype: workingMimetype,
                ptt: true
            }, { quoted: message })

        } catch (e) {
            console.error('[tts] error:', e.message)
            await reply('❌ TTS failed. Try again later.')
        }
        break
    }

    // ── WEATHER ─────────────────────────────────────────────
    case 'weather': {
        if (!fullArgs) { await reply(`Usage: ${p}weather <city,country>`); break }
        await reply('🌤️ Fetching weather details...')
        try {
            const place = await lookupLocation(fullArgs)
            if (!place) throw new Error('not found')
            const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
                params: {
                    latitude: place.latitude,
                    longitude: place.longitude,
                    current_weather: true,
                    hourly: 'relativehumidity_2m,apparent_temperature',
                    timezone: place.timezone,
                },
                timeout: 10_000,
            })
            const current = res.data.current_weather || {}
            const hourIndex = res.data.hourly?.time?.indexOf(current.time)
            const humidity = hourIndex >= 0 ? res.data.hourly.relativehumidity_2m[hourIndex] : 'N/A'
            const feels = hourIndex >= 0 ? res.data.hourly.apparent_temperature[hourIndex] : current.temperature
            const condition = weatherCodeDescription(current.weathercode)
            const header = [
                `🌍 Country : ${place.country}`,
                `📍 City    : ${place.name}${place.admin1 ? ', ' + place.admin1 : ''}`,
            ]
            const body = [
                `🌤️ Weather : ${condition}`,
                `🌡️ Temp    : ${current.temperature}°C`,
                `🥵 Feels   : ${feels}°C`,
                `💧 Humidity: ${humidity}%`,
                `🌬️ Wind    : ${current.windspeed} km/h`,
            ]
            await reply(premiumPanel('WEATHER REPORT', header, body))
        } catch {
            await reply('❌ Unable to fetch weather for that location.')
        }
        break
    }

    // ── NEWS ────────────────────────────────────────────────
    case 'news': {
        await reply('📰 Fetching news...')
        try {
            const url = 'https://api.reddit.com/r/worldnews/hot.json?limit=5&raw_json=1'
            const res = await axios.get(url, {
                timeout: 15_000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                },
            })
            const posts = res.data?.data?.children?.map(p => p.data)
            if (!posts?.length) throw new Error('no posts')
            let text = '📰 *Latest News (Reddit)*\n\n'
            posts.forEach((p, i) => { text += `*${i+1}.* ${p.title}\n🔗 https://reddit.com${p.permalink}\n\n` })
            await reply(text)
        } catch {
            await reply('❌ Failed to fetch news.')
        }
        break
    }

    // ── TIME / DATE / CALENDAR ──────────────────────────────
    case 'time': {
        if (!fullArgs) { await reply(`Usage: ${p}time <city,country>`); break }
        await reply('🕐 Fetching world time...')
        try {
            const place = await lookupLocation(fullArgs)
            if (!place) throw new Error('not found')
            const now = new Date()
            const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: place.timezone }).format(now)
            const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: place.timezone }).format(now)
            const header = [
                `🌍 Country : ${place.country}`,
                `📍 City    : ${place.name}${place.admin1 ? ', ' + place.admin1 : ''}`,
            ]
            const body = [
                `⏰ Time    : ${time}`,
                `📅 Day     : ${day}`,
                `🌐 Zone    : ${place.timezone}`,
                `📡 Status  : LIVE`,
            ]
            await reply(premiumPanel('WORLD CLOCK', header, body))
        } catch {
            await reply('❌ Unable to find that city or country.')
        }
        break
    }
    case 'date': {
        if (!fullArgs) { await reply(`Usage: ${p}date <city,country>`); break }
        await reply('📅 Fetching date info...')
        try {
            const place = await lookupLocation(fullArgs)
            if (!place) throw new Error('not found')
            const now = new Date()
            const dateString = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: place.timezone }).format(now)
            const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: place.timezone }).format(now)
            const header = [
                `🌍 Country : ${place.country}`,
                `📍 City    : ${place.name}${place.admin1 ? ', ' + place.admin1 : ''}`,
            ]
            const body = [
                `📅 Date    : ${dateString}`,
                `🗓️ Day     : ${day}`,
                `🌐 Status  : SYNCED`,
            ]
            await reply(premiumPanel('DATE SYSTEM', header, body))
        } catch {
            await reply('❌ Unable to find that city or country.')
        }
        break
    }
    case 'calendar': {
        const now = new Date()
        const { monthName, year, rows } = formatCalendarMonth(now)
        const header = [`📆 Month: ${monthName} ${year}`]
        const body = ['Su Mo Tu We Th Fr Sa', ...rows]
        await reply(premiumPanel('CALENDAR', header, body))
        break
    }

    // ── MEME ────────────────────────────────────────────────
    case 'meme': {
        try {
            const res  = await axios.get('https://meme-api.com/gimme', { timeout: 15_000 })
            const meme = res.data
            await sendStyledMessage(sock, chatId, { image: { url: meme.url }, caption: `😂 *${meme.title}*\n\nr/${meme.subreddit}` }, { quoted: message }, settings)
        } catch { await reply('❌ Failed to fetch meme.') }
        break
    }

    // ── 8BALL ───────────────────────────────────────────────
    case '8ball': {
        if (!fullArgs) { await reply(`Usage: ${p}8ball <question>`); break }
        const responses = ['It is certain','Without a doubt','Yes definitely','Most likely','Reply hazy','Ask again later','Don\'t count on it','My reply is no','Very doubtful','Absolutely!','No way!','Probably not','Outlook good']
        await reply(`🎱 *Magic 8 Ball*\n\n❓ ${fullArgs}\n\n💬 ${responses[Math.floor(Math.random() * responses.length)]}`)
        break
    }

    // ── JOKE ────────────────────────────────────────────────
    case 'joke': {
        try {
            const res = await axios.get('https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,racist,sexist', { timeout: 10_000 })
            const joke = res.data.joke || `${res.data.setup}\n\n${res.data.delivery}`
            await reply(`😂 *Joke*\n\n${joke}`)
        } catch {
            const jokes = ['Why do scientists not trust atoms? Because they make up everything!','What do you call fake spaghetti? An impasta!']
            await reply(`😂 *Joke*\n\n${jokes[Math.floor(Math.random()*jokes.length)]}`)
        }
        break
    }

    // ── QUOTE ───────────────────────────────────────────────
    case 'quote': {
        try {
            const res   = await axios.get('https://api.quotable.io/random', { timeout: 10_000 })
            await reply(`💭 *"${res.data.content}"*\n\n— ${res.data.author}`)
        } catch { await reply('💭 *"The only way to do great work is to love what you do."*\n\n— Steve Jobs') }
        break
    }

    // ── FACT ────────────────────────────────────────────────
    case 'fact': {
        try {
            const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en', { timeout: 10_000 })
            await reply(`🧠 *Fact*\n\n${res.data.text}`)
        } catch { await reply('🧠 *Fact*\n\nHoney never spoils. 3000-year-old honey found in Egyptian tombs is still edible!') }
        break
    }

    // ── ROLL / FLIP / RPS ───────────────────────────────────
    case 'roll': {
        const sides = Math.min(parseInt(fullArgs) || 6, 100)
        await reply(`🎲 You rolled: *${Math.floor(Math.random() * sides) + 1}* (1-${sides})`)
        break
    }
    case 'flip':
    case 'coin':
        await reply(`🪙 *${Math.random() < .5 ? 'Heads' : 'Tails'}*`)
        break
    case 'rps': {
        const choices = ['rock','paper','scissors']
        const user    = fullArgs?.toLowerCase()
        if (!choices.includes(user)) { await reply(`Usage: ${p}rps rock/paper/scissors`); break }
        const bot     = choices[Math.floor(Math.random()*3)]
        const win     = (user==='rock'&&bot==='scissors')||(user==='paper'&&bot==='rock')||(user==='scissors'&&bot==='paper')
        const tie     = user === bot
        await reply(`🎮 *Rock Paper Scissors*\n\nYou: ${user}\nBot: ${bot}\n\n${tie ? "🤝 Tie!" : win ? "🏆 You win!" : "😢 I win!"}`)
        break
    }

    // ── TRUTH / DARE ────────────────────────────────────────
    case 'truth': {
        const truths = ['What is your biggest fear?','Have you ever lied to your best friend?','What is your most embarrassing moment?','Who was your first crush?','What is a secret you\'ve never told anyone?']
        await reply(`😳 *Truth*\n\n${truths[Math.floor(Math.random()*truths.length)]}`)
        break
    }
    case 'dare': {
        const dares = ['Do 20 push-ups and report back!','Send a voice note singing your favourite song.','Text your best friend "I miss you" and report the reply.','Change your status to "I love this bot" for 1 hour.','Do 10 squats!']
        await reply(`🎯 *Dare*\n\n${dares[Math.floor(Math.random()*dares.length)]}`)
        break
    }

    // ── COMPLIMENT / ROAST / FLIRT ──────────────────────────
    case 'compliment': {
        const list = ['You have an amazing smile! 😊','You\'re incredibly smart! 🧠','Your kindness is contagious! ❤️','You have a heart of gold! 💛','You\'re absolutely amazing! ✨']
        const target = mentioned[0] || quotedSender || senderId
        await sendStyledMessage(sock, chatId, { text: `💝 *Compliment*\n\n@${target.split('@')[0]} ${list[Math.floor(Math.random()*list.length)]}`, mentions: [target] }, { quoted: message }, settings)
        break
    }
    case 'roast': {
        const list = ["You're the reason they put warning labels on everything! 😂","You're so slow, a sloth would beat you in a race! 🦥","You're like a software update — nobody wants you! 💻"]
        const target = mentioned[0] || quotedSender || senderId
        await sendStyledMessage(sock, chatId, { text: `🔥 *Roast* (just for fun!)\n\n@${target.split('@')[0]} ${list[Math.floor(Math.random()*list.length)]}`, mentions: [target] }, { quoted: message }, settings)
        break
    }
    case 'flirt': {
        const list = ["Are you a magician? Because whenever I look at you, everyone else disappears! 😍","Is your name Google? Because you have everything I've been searching for! 🔍","Are you Wi-Fi? Because I'm feeling a connection! 📶"]
        const target = mentioned[0] || quotedSender || senderId
        await sendStyledMessage(sock, chatId, { text: `💌 *Flirt* (just for fun!)\n\n@${target.split('@')[0]} ${list[Math.floor(Math.random()*list.length)]}`, mentions: [target] }, { quoted: message }, settings)
        break
    }

    // ── SHIP ────────────────────────────────────────────────
    case 'ship': {
        const targets = [...new Set([senderId, ...mentioned, quotedSender].filter(Boolean))]
        if (targets.length < 2) { await reply(`❌ Tag two people! ${p}ship @p1 @p2`); break }
        const [p1, p2] = targets
        const pct      = Math.floor(Math.random() * 41) + 60
        await sendStyledMessage(sock, chatId, { text: `💕 *Love Calculator*\n\n@${p1.split('@')[0]} ❤️ @${p2.split('@')[0]}\n\nCompatibility: *${pct}%* ${pct>=80?'🔥 Perfect match!':pct>=70?'💕 Great together!':'👍 Good friends!'}`, mentions: [p1,p2] }, { quoted: message }, settings)
        break
    }

    // ── GAMES ───────────────────────────────────────────────
    case 'tictactoe':
    case 'ttt': {
        if (!isGroup) { await reply('❌ Groups only!'); break }
        await tictactoeCommand(sock, chatId, senderId, fullArgs, settings, isAdmin, isOwner)
        break
    }
    case 'hangman':
        await startHangman(sock, chatId)
        break
    case 'guess': {
        const letter = (args[0] || fullArgs || '').trim()
        await guessLetter(sock, chatId, letter)
        break
    }
    case 'trivia':
        await startTrivia(sock, chatId)
        break
    case 'answer':
        await answerTrivia(sock, chatId, fullArgs)
        break

    // ════════════════════════════════════════════════════════
    // 🎧⚡ MEDIA ENGINE PRO MAX COMMANDS
    // ════════════════════════════════════════════════════════

    // ── PLAY (.play) ────────────────────────────────────────
    case 'play': {
        await playCommand(sock, chatId, message)
        break
    }

    // ── YTMP3 (Download Audio) ──────────────────────────────
    case 'ytmp3': {
        try {
            let url = String(fullArgs || '').trim()
            if (!url) {
                return reply(`Usage: .ytmp3 <youtube_url or search term>`)
            }
            let meta = null
            if (!/^https?:\/\//i.test(url)) {
                meta = await searchYouTube(url)
                if (!meta) {
                    return reply('❌ No results found.')
                }
                url = meta.url
            }
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            await sendStyledMessage(sock, chatId, { text: `🎧 Downloading audio: ${meta?.title || url}` }, { quoted: message }, settings)
            const userId = message.key?.participant || message.key?.remoteJid || 'global'
            const res = await fetchAudioForUser(userId, url)
            if (!res.success) {
                return reply(`❌ ${res.message}`)
            }
            await sock.sendMessage(chatId, {
                audio: res.buffer,
                mimetype: 'audio/mp4',
                fileName: `${sanitizeFileName(meta?.title || 'audio')}.m4a`
            }, { quoted: message, mentions: mentioned })
        } catch (e) {
            console.error('[ytmp3] error:', e.message)
            reply('❌ Audio download failed.')
        }
        break
    }

    // ── YTMP4 (Download Video) ──────────────────────────────
    case 'ytmp4': {
        try {
            let url = String(fullArgs || '').trim()
            if (!url) {
                return reply(`Usage: .ytmp4 <youtube_url or search term>`)
            }
            let meta = null
            if (!/^https?:\/\//i.test(url)) {
                meta = await searchYouTube(url)
                if (!meta) {
                    return reply('❌ No results found.')
                }
                url = meta.url
            }
            const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            await sendStyledMessage(sock, chatId, { text: `🎬 Downloading video: ${meta?.title || url}` }, { quoted: message }, settings)
            const userId = message.key?.participant || message.key?.remoteJid || 'global'
            const res = await fetchVideoForUser(userId, url)
            if (!res.success) {
                return reply(`❌ ${res.message}`)
            }
            await sendStyledMessage(sock, chatId, {
                video: res.buffer,
                mimetype: 'video/mp4',
                caption: `🎬 Video: ${meta?.title || 'download'}`,
                fileName: `${sanitizeFileName(meta?.title || 'video')}.mp4`
            }, { quoted: message, mentions: mentioned }, settings)
        } catch (e) {
            console.error('[ytmp4] error:', e.message)
            reply('❌ Video download failed.')
        }
        break
    }

    // ── VIDEO (Search + Download) ───────────────────────────
    case 'video': {
        await videoCommand(sock, chatId, message)
        break
    }

    // ── LYRICS (.lyrics) ────────────────────────────────────
    case 'lyrics': {
        try {
            const song = String(fullArgs || '').trim()
            if (!song) {
                return reply(`Usage: .lyrics <song_name>
Example: .lyrics Imagine Dragons - Believer`)
            }

            await reply('🎵 Fetching lyrics...')
            const result = await fetchLyrics(song)

            if (!result) {
                return reply('❌ Lyrics not found.')
            }

            const box = `╭━━〔 🎵 LYRICS 〕━━⬣
┃ Song: ${result.title}
┃ Artist: ${result.artist}
╰━━━━━━━━━━━━⬣

${result.lyrics}`

            await reply(box)
        } catch (e) {
            console.error('[lyrics] error:', e.message)
            reply('❌ Lyrics fetch failed.')
        }
        break
    }



    // ── TEXTMAKER (.tm / .textmaker) ────────────────────────────────────────
    case 'textmaker':
    case 'tm': {
        try {
            const input = fullArgs?.trim()
            if (!input) {
                const styles = getSupportedStyles()
                return reply(`Usage: .tm <style> <text>

Examples:
  .tm neonglitch NIXIE
  .tm gradienttext hello
  .tm style1917 NIXIE
  .tm blackpinkstyle NIXIE
  .tm freecreate hello

Trustbit Styles (${styles.trustbit.length}): ${styles.trustbit.join(', ')}`)
            }

            const parts = input.split(' ')
            const style = parts[0]
            const text = parts.slice(1).join(' ')

            if (!text) {
                return reply(`Usage: .tm <style> <text>
Example: .tm typography NIXIE`)
            }

            await reply('🎨 Generating styled text...')
            const buffer = await generateStyledText(style, text)

            if (!buffer) {
                return reply('❌ Generation failed. Try a different style or text.')
            }

            const msgOpts = { quoted: message }
            if (mentioned && mentioned.length > 0) msgOpts.mentions = mentioned

            await sendStyledMessage(sock, chatId, {
                image: buffer,
                caption: `🎨 TEXTMAKER PRO RESULT\n\nStyle: ${style}\nText: ${text}`
            }, msgOpts, settings).catch(() => {
                reply('❌ Failed to send image.')
            })
        } catch (e) {
            console.error('[tm] error:', e.message)
            reply('❌ Textmaker error.')
        }
        break
    }

    // ── MISC SYSTEM (.misc) ────────────────────────────────────
    case 'misc': {
        try {
            const input = fullArgs?.trim()
            if (!input) {
                const types = getSupportedMiscTypes()
                return reply(`Usage: .misc <type> <text/url>

TEXT EFFECTS (${types.textEffects.length}):
${types.textEffects.join(', ')}

UTILITIES (${types.utilities.length}):
${types.utilities.join(', ')}

Examples:
  .misc heart NIXIE
  .misc qr hello world
  .misc shorten https://google.com
  .misc wikipedia Python
  .misc urban hacker`)
            }

            const parts = input.split(' ')
            const type = parts[0]
            const text = parts.slice(1).join(' ')

            if (!text && !['ip', 'joke2', 'advice', 'cat', 'dog', 'meme2'].includes(type)) {
                return reply(`Usage: .misc <type> <text>
Example: .misc heart NIXIE`)
            }

            await reply('⚡ Processing...')
            const result = await processMisc(type, text)

            if (!result || !result.success) {
                return reply('❌ Service temporarily unavailable. Try again later.')
            }

            const msgOpts = { quoted: message }
            if (mentioned && mentioned.length > 0) msgOpts.mentions = mentioned

            // Handle image results
            if (result.buffer) {
                await sendStyledMessage(sock, chatId, {
                    image: result.buffer,
                    caption: `╭━━〔 ⚡ MISC RESULT 〕━━⬣\n┃ Type: ${type}\n┃ Result: Done\n╰━━━━━━━━━━━━⬣`
                }, msgOpts, settings).catch(() => {
                    reply('❌ Failed to send.')
                })
                return
            }

            // Handle image URLs
            if (result.url) {
                const caption = result.name
                  ? `╭━━〔 ⚡ MISC RESULT 〕━━⬣\n┃ Type: ${type}\n┃ Name: ${result.name}\n╰━━━━━━━━━━━━⬣`
                  : `╭━━〔 ⚡ MISC RESULT 〕━━⬣\n┃ Type: ${type}\n╰━━━━━━━━━━━━⬣`
                await sendStyledMessage(sock, chatId, {
                    image: { url: result.url },
                    caption
                }, msgOpts, settings).catch(() => {
                    reply('❌ Failed to send.')
                })
                return
            }

            // Handle text results
            if (result.result) {
                const box = `╭━━〔 ⚡ MISC RESULT 〕━━⬣
┃ Type: ${type}
┃ Result:
╰━━━━━━━━━━━━⬣

${result.result}`
                await reply(box)
                return
            }
        } catch (e) {
            console.error('[misc] error:', e.message)
            reply('❌ Misc error.')
        }
        break
    }

    // ── ANIME SYSTEM (.anime) ──────────────────────────────────
    case 'anime': {
        try {
            const input = fullArgs?.trim()
            if (!input) {
                const types = getSupportedAnimeTypes()
                return reply(`Usage: .anime <type> <text>

ACTIONS (${types.actions.length}):
${types.actions.join(', ')}

INFO (${types.info.length}):
${types.info.join(', ')}

Examples:
  .anime hug
  .anime kiss
  .anime anime Naruto
  .anime manga Bleach
  .anime character Luffy
  .anime waifu
  .anime animequote
  .anime topanime`)
            }

            const parts = input.split(' ')
            const type = parts[0]
            const query = parts.slice(1).join(' ')

            if (!query && !['waifu', 'husbando', 'neko', 'foxgirl', 'animequote', 'animenews', 'topanime', 'topmanga', 'seasonal', 'hug', 'kiss', 'pat', 'cry', 'wink', 'poke', 'nom', 'facepalm'].includes(type)) {
                return reply(`Usage: .anime <type> <query>
Example: .anime anime Naruto`)
            }

            await reply('🎌 Processing...')
            const result = await processAnime(type, query)

            if (!result || !result.success) {
                return reply('❌ Anime service temporarily unavailable.')
            }

            const msgOpts = { quoted: message }
            if (mentioned && mentioned.length > 0) msgOpts.mentions = mentioned

            // Handle image results (actions & random images)
            if (result.url) {
                await sendStyledMessage(sock, chatId, {
                    image: { url: result.url },
                    caption: `╭━━〔 🎌 ANIME RESULT 〕━━⬣\n┃ Type: ${type}\n╰━━━━━━━━━━━━⬣`
                }, msgOpts, settings).catch(() => {
                    reply('❌ Failed to send.')
                })
                return
            }

            // Handle info results (anime, manga, character, etc.)
            if (result.result) {
                let box = ''

                if (result.result.title) {
                  // Anime/Manga/Character result
                  box = `╭━━〔 🎌 ANIME RESULT 〕━━⬣
┃ Type: ${type}
┃ Title: ${result.result.title}
┃ Score: ${result.result.score || 'N/A'}
${result.result.status ? `┃ Status: ${result.result.status}` : ''}
${result.result.episodes ? `┃ Episodes: ${result.result.episodes}` : ''}
${result.result.chapters ? `┃ Chapters: ${result.result.chapters}` : ''}
${result.result.genre ? `┃ Genre: ${result.result.genre}` : ''}
╰━━━━━━━━━━━━⬣

${result.result.synopsis || result.result.about || result.result.excerpt || 'N/A'}`
                  
                  if (result.result.image) {
                                        await sendStyledMessage(sock, chatId, {
                                            image: { url: result.result.image },
                                            caption: box
                                        }, msgOpts, settings).catch(() => {
                                            reply(box)
                                        })
                    return
                  }
                } else {
                  // Text result (quote, news, top lists)
                  box = `╭━━〔 🎌 ANIME RESULT 〕━━⬣
┃ Type: ${type}
╰━━━━━━━━━━━━⬣

${result.result}`
                }

                await reply(box)
                return
            }
        } catch (e) {
            console.error('[anime] error:', e.message)
            reply('❌ Anime error.')
        }
        break
    }

    default:
        if (process.env.DEBUG_COMMANDS === '1' || process.env.DEBUG_COMMANDS_VERBOSE === '1') {
            console.log(`[cmd_debug] no handler matched -> .${cmd} chat=${chatId} sender=${senderId}`)
        }
        break
    }
}

// ────────────────────────────────────────────────────────────
// GROUP EVENTS
// ────────────────────────────────────────────────────────────
async function handleGroupParticipantUpdate(sock, update) {
    try {
        const { id, participants, action } = update
        if (!id.endsWith('@g.us')) return

        if (action === 'add') {
            // Run anti-bot checks for new participants (non-blocking)
            try {
                const { handleAntiBot } = require('./lib/hackerGuard')
                for (const p of participants) runInBackground(() => handleAntiBot(sock, update, id, p), p).catch(() => {})
            } catch (e) {}

            if (await DB.isWelcomeEnabled(id)) {
                for (const p of participants) {
                    try {
                        const meta = await sock.groupMetadata(id)
                        let pp; try { pp = await sock.profilePictureUrl(p, 'image') } catch {}
                        const text = `👋 Welcome @${p.split('@')[0]} to *${meta.subject}*!\nMembers: ${meta.participants.length}`
                        const msgObj = pp ? { image: { url: pp }, caption: text, mentions: [p] } : { text, mentions: [p] }
                        await sendStyledMessage(sock, id, msgObj, {}, {})
                    } catch {}
                }
            }
        }

        if (action === 'remove') {
            if (await DB.isGoodbyeEnabled(id)) {
                for (const p of participants) {
                    try {
                        const meta = await sock.groupMetadata(id)
                        await sendStyledMessage(sock, id, { text: `👋 Goodbye @${p.split('@')[0]} from *${meta.subject}*!`, mentions: [p] }, {}, {})
                    } catch {}
                }
            }
        }

        // Anti group status modifications (promote/demote) — warn if configured
        if (['promote','demote','announce','demote'].includes(action)) {
            try {
                const { handleAntiGroupStatus } = require('./lib/hackerGuard')
                for (const p of participants) runInBackground(() => handleAntiGroupStatus(sock, id, action, p), p).catch(() => {})
            } catch (e) {}
        }
    } catch {}
}

// ────────────────────────────────────────────────────────────
// STATUS UPDATE HANDLER
// ────────────────────────────────────────────────────────────
async function handleStatusUpdate(sock, statusUpdate) {
    try {
        const msgs = statusUpdate?.messages || []
        const direct = statusUpdate?.key?.remoteJid === 'status@broadcast' ? statusUpdate : null
        const msg = msgs[0] || direct
        if (!msg?.key) return
        if (msg.key.remoteJid !== 'status@broadcast') return

        await checkStatusForViolations(sock, msg)
    } catch (error) {
        console.error('Error in handleStatusUpdate:', error?.message || error)
    }
}

// ────────────────────────────────────────────────────────────
// CALL HANDLER
// ────────────────────────────────────────────────────────────
async function handleCall(sock, calls) {
    try {
        const cfg = await DB.getFeature('anticall')
        if (!cfg?.enabled) return
        for (const call of calls) {
            if (call.status === 'offer') {
                await sock.rejectCall(call.id, call.from).catch(() => {})
                await sendStyledMessage(sock, call.from, '📵 Calls are disabled on this Number!', {}, {})
            }
        }
    } catch {}
}

module.exports = {
    handleMessages,
    handleGroupParticipantUpdate,
    handleCall,
    handleStatusUpdate,
    cleanJid,
    extractMessageText,
    getUserId,
}
