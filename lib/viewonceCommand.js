const { downloadContentFromMessage } = require('@whiskeysockets/baileys')

// Recursively search object for first occurrence of media message
function findMedia(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null

    if (obj.imageMessage) return { msg: obj.imageMessage, type: 'image' }
    if (obj.videoMessage) return { msg: obj.videoMessage, type: 'video' }
    if (obj.audioMessage) return { msg: obj.audioMessage, type: 'audio' }

    // common view-once wrappers
    if (obj.viewOnceMessage) return findMedia(obj.viewOnceMessage, depth + 1)
    if (obj.viewOnceMessageV2) return findMedia(obj.viewOnceMessageV2, depth + 1)
    if (obj.message) return findMedia(obj.message, depth + 1)

    for (const k of Object.keys(obj)) {
        if (obj[k] && typeof obj[k] === 'object') {
            const res = findMedia(obj[k], depth + 1)
            if (res) return res
        }
    }
    return null
}

async function viewonceCommand(sock, chatId, message) {
    try {
        // quoted message context (same shape as main.js uses)
        const quoted = message.message?.extendedTextMessage?.contextInfo || null
        const quotedMsg = quoted?.quotedMessage || null

        if (!quotedMsg) {
            await sock.sendMessage(chatId, { text: '❌ Reply to a view-once message.' }, { quoted: message })
            return
        }

        const media = findMedia(quotedMsg)
        if (!media) {
            await sock.sendMessage(chatId, { text: '❌ No media found in quoted message.' }, { quoted: message })
            return
        }

        const { msg: mediaMsg, type } = media
        const stream = await downloadContentFromMessage(mediaMsg, type)
        let buffer = Buffer.alloc(0)
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk])

        if (!buffer || buffer.length === 0) {
            await sock.sendMessage(chatId, { text: '❌ Failed to retrieve media (empty buffer).' }, { quoted: message })
            return
        }

        if (type === 'image') {
            await sock.sendMessage(chatId, { image: buffer, caption: mediaMsg.caption || '' }, { quoted: message })
        } else if (type === 'video') {
            await sock.sendMessage(chatId, { video: buffer, caption: mediaMsg.caption || '' }, { quoted: message })
        } else if (type === 'audio') {
            await sock.sendMessage(chatId, { audio: buffer, mimetype: mediaMsg.mimetype || 'audio/mp4', ptt: !!mediaMsg.ptt }, { quoted: message })
        } else {
            await sock.sendMessage(chatId, { text: '❌ Unsupported media type.' }, { quoted: message })
        }
    } catch (err) {
        console.error('[viewonce] error:', err?.message || err)
        await sock.sendMessage(chatId, { text: '❌ Failed to retrieve media.' }, { quoted: message })
    }
}

module.exports = viewonceCommand
