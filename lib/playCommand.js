const { searchYouTube, fetchAudioForUser } = require('./mediaEngine')
const { cacheManager } = require('./cacheManager')

async function playCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const args = text.split(' ').slice(1).join(' ').trim();
        if (!args) return await sock.sendMessage(chatId, { text: 'Usage: .play <song name or url>' }, { quoted: message })

        let url = args
        let meta = null
        if (!/^https?:\/\//i.test(args)) {
            meta = await searchYouTube(args)
            if (!meta) return await sock.sendMessage(chatId, { text: 'No results found.' }, { quoted: message })
            url = meta.url
        }

        await sock.sendMessage(chatId, { text: `Processing: ${meta?.title || url}` }, { quoted: message })

        const userId = message.key?.participant || message.key?.remoteJid || 'global'
        const res = await fetchAudioForUser(userId, url)
        if (!res.success) {
            return await sock.sendMessage(chatId, { text: `❌ ${res.message}` }, { quoted: message })
        }

        await sock.sendMessage(chatId, { audio: res.buffer, mimetype: 'audio/mpeg' }, { quoted: message })
    } catch (err) {
        console.error('playCommand error', err)
        await sock.sendMessage(chatId, { text: 'Unable to process request.' }, { quoted: message })
    }
}

module.exports = playCommand
