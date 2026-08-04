require('dotenv').config()
const axios = require('axios')
const path = require('path')
const fs = require('fs')

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10) || 0
if (nodeMajor < 20) {
    console.error(`Node ${process.versions.node} detected. Requires Node >= 20.`)
    process.exit(1)
}

const isAdmin = require('./lib/isAdmin');
const store = require('./lib/lightweight_store');
const chalk = require('chalk')
const express = require('express')
const NodeCache = require('node-cache')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const {
    connectMongo,
    useMongoAuthState,
    deleteSession,
    getAllSessions,
} = require('./lib/mongoAuth')

// Suppress noisy Baileys internal errors
const _origConsoleError = console.error.bind(console)
console.error = (...args) => {
    const msg = args[0]?.toString() || ''
    if (
        msg.includes('Bad MAC') ||
        msg.includes('Session error') ||
        msg.includes('Failed to decrypt') ||
        msg.includes('Closing session') ||
        msg.includes('Removing old') ||
        msg.includes('Decrypted message with closed session') ||
        msg.includes('SessionEntry') ||
        msg.includes('previousCounter') ||
        msg.includes('pendingPreKey') ||
        msg.includes('registrationId') ||
        msg.includes('ephemeralKeyPair') ||
        msg.includes('rootKey') ||
        msg.includes('indexInfo') ||
        msg.includes('baseKey') ||
        msg.includes('_chains') ||
        msg.includes('Unsupported state') ||
        msg.includes('unable to authenticate data') ||
        msg.includes('aesDecryptGCM') ||
        msg.includes('Decipheriv.final') ||
        msg.includes('decodeFrame') ||
        msg.includes('WebSocketClient.onMessageReceived')
    ) return
    _origConsoleError(...args)
}

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message))
process.on('unhandledRejection', (err) => {
    // Simple handler for WebSocket disconnect errors
    if (err?.message?.includes('1006') || err?.code === 1006) {
        console.error('WebSocket disconnect (1006): User session dropped')
        return
    }
    
    // Filter out all WhatsApp connection and authentication errors
    const connectionErrors = [
        'Connection Closed',
        'Connection lost', 
        'Connection terminated',
        'Network error',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNREFUSED',
        'Unsupported state',
        'Authentication failed',
        'Timed Out',
        'timeout',
        'channelInfo is not defined',
        'Error: Timed Out',
        'generics.js',
        '@whiskeysockets/baileys/lib/Utils/generics.js',
        'AxiosError',
        'AggregateError',
        'storeMessage error',
        'ETIMEDOUT',
        'mmg.whatsapp.net',
        'EPIPE',
        'write EPIPE'
     ]
    
    const errorMessage = String(err?.message || err || '')
    const isConnectionError = connectionErrors.some(errType => 
        errorMessage.includes(errType) || errorMessage.includes(errType.toLowerCase())
    )
    
    // Also filter out stack traces for connection errors
    const stackTrace = String(err?.stack || '')
    const hasConnectionStack = connectionErrors.some(errType => 
        stackTrace.includes(errType) || stackTrace.includes(errType.toLowerCase())
    )
    
    if (!isConnectionError && !hasConnectionStack) {
        console.error('Unhandled Rejection:', errorMessage)
    }
})

// WhatsApp session cleanup function
async function cleanupCorruptedSession() {
    try {
        console.log('🧹 Checking WhatsApp session state...')
        
        // Try to clear any corrupted session data
        const { deleteSession } = require('./lib/mongoAuth')
        if (deleteSession) {
            await deleteSession()
            console.log('✅ Session cleanup completed')
        }
    } catch (error) {
        console.log('ℹ️ Session cleanup not needed or failed:', error.message)
    }
}

if (typeof File === 'undefined') {
    global.File = class File {
        constructor(parts, filename = 'file', options = {}) {
            const buffers = (parts || []).map(p => Buffer.isBuffer(p) ? p : Buffer.from(String(p)))
            this._buf = Buffer.concat(buffers.length ? buffers : [Buffer.alloc(0)])
            this.name = filename
            this.size = this._buf.length
            this.type = options.type || ''
            this.lastModified = options.lastModified || Date.now()
        }
        arrayBuffer() { return this._buf.buffer }
        text() { return this._buf.toString() }
    }
}

let handleMessages, handleGroupParticipantUpdate, handleCall
try {
    ;({ handleMessages, handleGroupParticipantUpdate, handleCall } = require('./main'))
} catch (err) {
    console.error('Failed to load ./main:', err.message)
    process.exit(1)
}

const settings = require('./settings')

// Optional AI keys are not required for pairing/session startup.
// Avoid noisy warnings during normal boot.

// ── DATA DIR SETUP ───────────────────────────────────────────
const dataDir = path.join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
if (!fs.existsSync('./data/owner.json')) fs.writeFileSync('./data/owner.json', '[]')
if (!fs.existsSync('./data/messageCount.json')) fs.writeFileSync('./data/messageCount.json', '{"isPublic":false}')

// ── PAIRING WEBSITE ─────────────────────────────────────────
const app = express()
const PORT = process.env.PORT || 8080
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use((req, res, next) => {
    res.on('error', (err) => {
        if (err.code === 'EPIPE') return
    })
    req.socket.on('error', (err) => {
        if (err.code === 'EPIPE') return
    })
    next()
})

// Start server immediately
app.listen(PORT, '0.0.0.0', () => {
    console.log(chalk.green(`🌐 Pairing website running on port ${PORT}`))
    // Keep-alive ping every 14 minutes
    const SELF_URL = process.env.EXTERNAL_URL || `http://localhost:${PORT}`
    setInterval(async () => {
        try { await axios.get(SELF_URL + '/').catch(() => {}) } catch {}
    }, 14 * 60 * 1000)
})

function loadPairingHtml() {
    const candidates = [
        path.join(__dirname, 'nixie-pairing.html'),
        path.join(__dirname, 'pairing.html'),
    ]
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8')
        } catch {}
    }
    return '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><p>Missing pairing page. Add <code>nixie-pairing.html</code> next to <code>index.js</code>.</p></body></html>'
}
const PAIRING_HTML = loadPairingHtml()

app.get('/', (req, res) => res.send(PAIRING_HTML))

const pendingCodes = new Map()
const activeSessions = new Map()
const pairingLocks = new Set()
const connectionLog = new Set() // Track logged connections to prevent spam

function logActiveUsersSummary() {
    console.log(chalk.blue(`Active Users: ${activeSessions.size}`))
}

logActiveUsersSummary()

/** When true, host is stopping — do not wipe Mongo session on connection close. */
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
        shuttingDown = true
    })
}

app.get('/pair', async (req, res) => {
    const number = req.query.number
    if (!number) return res.json({ error: 'No number provided' })
    const clean = number.replace(/[^0-9]/g, '')
    if (!clean || clean.length < 7) return res.json({ error: 'Invalid phone number.' })

    const existing = activeSessions.get(clean)
    if (existing?.sock) {
        res.json({ status: 'pending' });
        (async () => {
            try {
                let code = await existing.sock.requestPairingCode(clean)
                code = code?.match(/.{1,4}/g)?.join('-') || code
                pendingCodes.set(clean, { code, time: Date.now() })
                console.log(chalk.cyan(`🔑 (existing) Pairing code for +${clean}: ${code}`))
            } catch (e) {
                pendingCodes.set(clean, { error: e.message || 'Failed', time: Date.now() })
            }
        })()
        return
    }

    res.json({ status: 'pending' })
    startBotSession(clean, false).catch(err => {
        pendingCodes.set(clean, { error: err.message || 'Failed', time: Date.now() })
    })
})

app.get('/code', (req, res) => {
    const number = req.query.number?.replace(/[^0-9]/g, '')
    if (!number) return res.json({ error: 'No number' })
    const entry = pendingCodes.get(number)
    if (!entry) return res.json({ status: 'waiting' })
    if (Date.now() - entry.time > 300000) { pendingCodes.delete(number); return res.json({ status: 'waiting' }) }
    if (entry.error) { pendingCodes.delete(number); return res.json({ error: entry.error }) }
    return res.json({ code: entry.code })
})

// ── BOT SESSION ──────────────────────────────────────────────
async function startBotSession(phoneNumber, isReconnect = false) {
    if (pairingLocks.has(phoneNumber)) {
        console.log(chalk.yellow(`⚠️ Session already starting for +${phoneNumber}`))
        return
    }
    pairingLocks.add(phoneNumber)

    try {
        const baileys = await import('@whiskeysockets/baileys')
        const {
            default: makeWASocket,
            DisconnectReason,
            fetchLatestBaileysVersion,
            jidDecode,
            jidNormalizedUser,
            makeCacheableSignalKeyStore,
            Browsers,
            delay: baileyDelay,
        } = baileys

        const delay = baileyDelay || ((ms) => new Promise(r => setTimeout(r, ms)))
        const { version } = await fetchLatestBaileysVersion()
        const { state, saveCreds } = await useMongoAuthState(phoneNumber)

        const alreadyRegistered = state.creds.registered === true
        if (!isReconnect && !alreadyRegistered) state.creds.registered = false
        const needsPairing = !isReconnect && !alreadyRegistered

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            msgRetryCounterCache: new NodeCache(),
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 20000,
            retryRequestDelayMs: 3000,
            shouldIgnoreJid: (jid) => jid.includes('@broadcast'),
            shouldSyncHistoryMessage: () => false,
        })

        const promiseTimeout = (promise, ms, errorMessage = 'Operation timed out') => {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(errorMessage)), ms)
                promise.then((value) => {
                    clearTimeout(timer)
                    resolve(value)
                }).catch((error) => {
                    clearTimeout(timer)
                    reject(error)
                })
            })
        }

        const originalSendMessage = sock.sendMessage.bind(sock)
        sock.sendMessage = async (jid, content, options = {}) => {
            return promiseTimeout(originalSendMessage(jid, content, options), 20000, 'sendMessage timed out')
        }

        const originalGroupMetadata = sock.groupMetadata.bind(sock)
        sock.groupMetadata = async (jid) => {
            return promiseTimeout(originalGroupMetadata(jid), 15000, 'groupMetadata timed out')
        }

        if (typeof sock.sendPresenceUpdate === 'function') {
            const originalSendPresence = sock.sendPresenceUpdate.bind(sock)
            sock.sendPresenceUpdate = async (...args) => {
                return promiseTimeout(originalSendPresence(...args), 8000, 'sendPresenceUpdate timed out')
            }
        }

        activeSessions.set(phoneNumber, { sock })
        sock.ev.on('creds.update', saveCreds)

        let myPhoneNumber = null
        let codeIssued = false
        let reconnecting = false

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update

            if (connection === 'connecting') {
                // console.log(chalk.yellow(
                //     isReconnect || alreadyRegistered
                //         ? `🔄 Reconnecting +${phoneNumber}...`
                //         : `🔄 New pairing session for +${phoneNumber}...`
                // ))
                if (needsPairing && !codeIssued) {
                    try {
                        await delay(3000)
                        let code = await sock.requestPairingCode(phoneNumber)
                        code = code?.match(/.{1,4}/g)?.join('-') || code
                        codeIssued = true
                        pairingLocks.delete(phoneNumber)
                        console.log(chalk.cyan(`🔑 Pairing code for +${phoneNumber}: ${code}`))
                        pendingCodes.set(phoneNumber, { code, time: Date.now() })
                    } catch (e) {
                        console.log(chalk.yellow(`⏳ Will retry code on open: ${e.message}`))
                    }
                }
            }

            if (connection === 'open') {
                reconnecting = false
                myPhoneNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || phoneNumber
                
                // Only log new connections, not reconnections, and prevent spam
                if (needsPairing && !codeIssued && !connectionLog.has(myPhoneNumber)) {
                    console.log(chalk.green(`✅ Connected +${myPhoneNumber}`))
                    connectionLog.add(myPhoneNumber)
                }

                if (needsPairing && !codeIssued) {
                    try {
                        await delay(2000)
                        let code = await sock.requestPairingCode(myPhoneNumber)
                        code = code?.match(/.{1,4}/g)?.join('-') || code
                        codeIssued = true
                        pairingLocks.delete(phoneNumber)
                        console.log(chalk.cyan(`🔑 Pairing code for +${phoneNumber}: ${code}`))
                        pendingCodes.set(phoneNumber, { code, time: Date.now() })
                    } catch (e) {
                        console.log(chalk.red(`❌ Code error: ${e.message}`))
                    }
                }

                pairingLocks.delete(phoneNumber)
                activeSessions.set(myPhoneNumber, { sock })
                if (myPhoneNumber !== phoneNumber) activeSessions.set(phoneNumber, { sock })
                logActiveUsersSummary()

                // Save owner number + LID
                try {
                    const ownerFile = path.join(__dirname, 'data', 'owner.json')
                    let owners = []
                    try { owners = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); if (!Array.isArray(owners)) owners = [] } catch {}
                    if (!owners.includes(myPhoneNumber)) owners.push(myPhoneNumber)
                    const myLid = sock.user?.lid?.split(':')[0]?.split('@')[0]
                    if (myLid && !owners.includes(myLid)) owners.push(myLid)
                    fs.writeFileSync(ownerFile, JSON.stringify(owners, null, 2))
                    global.owner = owners
                } catch {}

                // console.log(chalk.green(`✅ Connected: +${myPhoneNumber} | Sessions: ${activeSessions.size}`))

                if (!isReconnect) {
                    try {
                        await sock.sendMessage(myPhoneNumber + '@s.whatsapp.net', {
                            text: `🤖 *Nixie Bot Connected!*\n⏰ ${new Date().toLocaleString()}\n✅ Ready to use!`
                        })
                    } catch {}
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode
                const errorMessage = String(lastDisconnect?.error?.message || 'Unknown error')
                const pn = myPhoneNumber || phoneNumber
                pairingLocks.delete(phoneNumber)
                activeSessions.delete(phoneNumber)
                if (myPhoneNumber && myPhoneNumber !== phoneNumber) activeSessions.delete(myPhoneNumber)
                logActiveUsersSummary()

                // Deploy / sleep / SIGTERM: never delete Mongo session
                if (shuttingDown) {
                    if (process.env.DEBUG_SESSIONS === '1') {
                        console.log(chalk.gray(`[session] close during shutdown (Mongo kept): +${pn}`))
                    }
                    return
                }

                const reallyLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401
                const isAuthError = errorMessage.includes('Unsupported state') || errorMessage.includes('authenticate data')

                // Only wipe Mongo when WhatsApp explicitly invalidated the device (user removed link / logged out).
                if (reallyLoggedOut || isAuthError) {
                    if (process.env.DEBUG_SESSIONS === '1') {
                        console.log(chalk.red(`🔴 ${isAuthError ? 'Auth error' : 'Logged out'} — clearing stored session: +${pn}`))
                    }
                    await deleteSession(pn).catch(() => {})
                    connectionLog.delete(pn) // Clear connection log to allow fresh connection message
                    const sessions = await getAllSessions()
                    const others = sessions.filter(s => s.phoneNumber !== pn)
                    if (others.length > 0) startBotSession(others[0].phoneNumber, true)
                    return
                }

                // Handle connection closed errors (428, 515, etc.) - reconnect with session preserved
                if (statusCode === 428 || statusCode === 515 || statusCode === DisconnectReason.connectionClosed) {
                    // Silent reconnect - no console spam
                    if (!reconnecting) {
                        reconnecting = true
                        await delay(5000)
                        startBotSession(pn, true)
                    }
                    return
                }

                // badSession / flaky network / host idle: reconnect, keep Mongo
                if (statusCode === DisconnectReason.badSession) {
                    // Silent reconnect - no console spam
                    if (!reconnecting) {
                        reconnecting = true
                        await delay(8000)
                        startBotSession(pn, true)
                    }
                    return
                }

                // Any other connection error - log and attempt reconnect
                const now = Date.now()
                const lastConnectionError = global.lastConnectionError || 0
                
                // Completely filter out connection lost messages
                // Don't log any connection errors to reduce console spam
                
                if (!reconnecting) {
                    reconnecting = true
                    await delay(5000)
                    startBotSession(pn, true)
                }
            }
        })

        // ── Message Handler ──────────────────────────────────
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0]
                if (!mek?.message) return
                mek.message = Object.keys(mek.message)[0] === 'ephemeralMessage'
                    ? mek.message.ephemeralMessage.message : mek.message
                if (mek.key?.fromMe) return
                
                // Handle status updates with AutoViewStatus
                if (mek.key?.remoteJid === 'status@broadcast') {
                    try {
                        const { handleStatusUpdate } = require('./main')
                        await handleStatusUpdate(sock, chatUpdate)
                    } catch (e) {
                        console.error('AutoViewStatus error:', e.message)
                    }
                    return
                }
                
                await handleMessages(sock, chatUpdate, true)
            } catch (e) {
                if (process.env.DEBUG_SESSIONS === '1') console.error(`[Session:${phoneNumber}] error:`, e.message)
            }
        })

        // ── Group Participant Update ──────────────────────────
        sock.ev.on('group-participants.update', async (update) => {
            try { await handleGroupParticipantUpdate(sock, update) } catch {}
        })

        // ── Call Handler ─────────────────────────────────────
        sock.ev.on('call', async (calls) => {
            try { if (handleCall) await handleCall(sock, calls) } catch {}
        })

        sock.decodeJid = (jid) => {
            if (!jid) return jid
            if (/:\d+@/gi.test(jid)) {
                const d = jidDecode(jid) || {}
                return d.user && d.server ? d.user + '@' + d.server : jid
            }
            return jid
        }

        sock.public = false
        return sock

    } catch (error) {
        pairingLocks.delete(phoneNumber)
        console.error(`Error in startBotSession for +${phoneNumber}:`, error.message)
        await new Promise(r => setTimeout(r, 5000))
        startBotSession(phoneNumber, isReconnect)
    }
}

// ── BOOT ─────────────────────────────────────────────────────
async function boot() {
    await connectMongo()
    const sessions = await getAllSessions()
    const real = sessions.filter(s => !s.phoneNumber.startsWith('pairing_'))
    if (real.length > 0) {
        console.log(chalk.cyan(`\n📱 Found ${real.length} saved session(s). Reconnecting...`))
        for (const session of real) await startBotSession(session.phoneNumber, true)
    } else {
        console.log(chalk.yellow('\n📱 No saved sessions. Visit the pairing website to connect.'))
    }
}

console.log(chalk.cyan('\n╔════════════════════════════════════════╗'))
console.log(chalk.cyan('║         NIXIE WHATSAPP BOT             ║'))
console.log(chalk.cyan('╠════════════════════════════════════════╣'))
console.log(chalk.cyan('║  ✓ Pairing Code Mode                  ║'))
console.log(chalk.cyan('║  ✓ MongoDB Session Storage            ║'))
console.log(chalk.cyan('╚════════════════════════════════════════╝\n'))

boot().catch(err => { console.error('Fatal error:', err); process.exit(1) })
