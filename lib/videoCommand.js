const { searchYouTube, fetchVideoForUser } = require('./mediaEngine')
const { sendVideoPayload } = require('./videoSender')

async function videoCommand(sock, chatId, message) {
  try {
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text || ''
    const args = text.split(' ').slice(1).join(' ').trim()
    if (!args) return await sock.sendMessage(chatId, { text: 'Usage: .video <search term or URL>' }, { quoted: message })

    let url = args
    let meta = null
    if (!/^https?:\/\//i.test(args)) {
      meta = await searchYouTube(args)
      if (!meta) return await sock.sendMessage(chatId, { text: 'No results found.' }, { quoted: message })
      url = meta.url
      if (meta.thumbnail) {
        await sock.sendMessage(chatId, { image: { url: meta.thumbnail }, caption: `Found: ${meta.title}` }, { quoted: message })
      }
    }

    await sock.sendMessage(chatId, { text: `Processing: ${meta?.title || url}` }, { quoted: message })

    const userId = message.key?.participant || message.key?.remoteJid || 'global'
    const res = await fetchVideoForUser(userId, url)
    if (!res.success) {
      return await sock.sendMessage(chatId, { text: `❌ ${res.message}` }, { quoted: message })
    }

    // delegate sending & fallbacks to shared sender utility
    try {
      await sendVideoPayload(sock, chatId, res.buffer, meta, message)
    } catch (err) {
      console.error('[videoCommand] sendVideoPayload failed:', err?.message || err)
      await sock.sendMessage(chatId, { text: '❌ Failed to send video. Try the .ytmp4 command or check logs.' }, { quoted: message })
    }
  } catch (err) {
    console.error('videoCommand error', err)
    await sock.sendMessage(chatId, { text: 'Unable to process request.' }, { quoted: message })
  }
}

module.exports = videoCommand
