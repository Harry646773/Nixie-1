const mongoose = require('mongoose')

// ── CONNECT ──────────────────────────────────────────────────
async function connectMongo() {
    const uri = process.env.MONGO_URI
    if (!uri) {
        console.error('❌ MONGO_URI not set!')
        process.exit(1)
    }
    if (mongoose.connection.readyState === 1) {
        console.log('Already connected')
        return
    }
    await mongoose.connect(uri)
    console.log('✅ MongoDB connected')
}

// ── SCHEMA ───────────────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    key:       { type: String, required: true },
    value:     { type: mongoose.Schema.Types.Mixed, required: true },
}, { collection: 'nixie_sessions' })

sessionSchema.index({ sessionId: 1, key: 1 }, { unique: true })

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema)

// ── AUTH STATE ───────────────────────────────────────────────
async function useMongoAuthState(sessionId) {
    const { initAuthCreds, BufferJSON, proto } = await import('@whiskeysockets/baileys')

    async function readData(key) {
        const doc = await Session.findOne({ sessionId, key }).lean()
        if (!doc) return null
        return JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver)
    }

    async function writeData(key, value) {
        const data = JSON.parse(JSON.stringify(value, BufferJSON.replacer))
        await Session.updateOne(
            { sessionId, key },
            { $set: { value: data } },
            { upsert: true }
        )
    }

    async function removeData(key) {
        await Session.deleteOne({ sessionId, key })
    }

    const creds = (await readData('creds')) || initAuthCreds()

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`)
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value)
                            }
                            data[id] = value
                        })
                    )
                    return data
                },
                set: async (data) => {
                    await Promise.all(
                        Object.entries(data).flatMap(([type, ids]) =>
                            Object.entries(ids).map(([id, value]) =>
                                value
                                    ? writeData(`${type}-${id}`, value)
                                    : removeData(`${type}-${id}`)
                            )
                        )
                    )
                },
            },
        },
        saveCreds: () => writeData('creds', creds),
    }
}

// ── HELPERS ──────────────────────────────────────────────────
async function getAllSessions() {
    const docs = await Session.distinct('sessionId', { key: 'creds' })
    return docs.map((phoneNumber) => ({ phoneNumber }))
}

async function deleteSession(sessionId) {
    await Session.deleteMany({ sessionId })
    console.log(`🗑️ Deleted session for ${sessionId}`)
}

module.exports = {
    connectMongo,
    useMongoAuthState,
    getAllSessions,
    deleteSession,
}
