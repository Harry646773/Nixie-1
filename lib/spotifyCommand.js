const axios = require('axios')
const { fetchRemoteBuffer, searchYouTube } = require('./mediaEngine')

async function tryTrustbitSpotify(spotifyUrl) {
  if (!spotifyUrl) return null
  const enc = encodeURIComponent(spotifyUrl)
  const candidates = [
    `https://trustbit-api-devtrust.onrender.com/api/download/spotifyv2?url=${enc}`,
    `https://trustbit-api-devtrust.onrender.com/api/download/spotify?url=${enc}`
  ]

  const extractUrlFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return null
    for (const value of Object.values(obj)) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
      if (typeof value === 'object') {
        const nested = extractUrlFromObject(value)
        if (nested) return nested
      }
    }
    return null
  }

  const isValidUrl = (url) => {
    if (typeof url !== 'string') return false
    if (!/^https?:\/\//i.test(url)) return false
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return false
      return true
    } catch {
      return false
    }
  }

  for (const ep of candidates) {
    try {
      const res = await axios.get(ep, { timeout: 30000, validateStatus: () => true })
      const body = res.data || {}
      const statusCode = res.status || body.statusCode || body.status

      if (statusCode === 410) continue

      let dl = null
      if (typeof body.download_url === 'string') dl = body.download_url
      else if (body.data && typeof body.data === 'object') {
        dl = body.data.download_url || body.data.url || body.data.play || body.data.hdplay
        if (!dl && Array.isArray(body.data.download_links)) dl = body.data.download_links[0]
        if (!dl) dl = extractUrlFromObject(body.data)
      } else if (typeof body.url === 'string') dl = body.url

      if (dl && typeof dl === 'string') {
        dl = dl.replace(/undefined+$/i, '')
        if (!/^https?:\/\//i.test(dl) && (/^[\w.-]+\//.test(dl) || /^[\w.-]+\./.test(dl))) {
          dl = 'https://' + dl
        }
        if (!isValidUrl(dl)) continue

        try {
          const buf = await fetchRemoteBuffer(dl, 50000000, 30000)
          if (buf) return buf
        } catch (err) {
          // continue to next endpoint
        }
      }
    } catch (err) {
      // continue to next endpoint
    }
  }
  return null
}

async function spotifyCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            ''

        const used = (rawText || '').split(/\s+/)[0] || '.spotify'
        const query = rawText.slice(used.length).trim()

        if (!query) {
            const { PREFIXES } = require('../config')
            await sock.sendMessage(chatId, { text: `Usage: ${PREFIXES[0]}spotify <song/artist/keywords>\nExample: ${PREFIXES[0]}spotify con calma` }, { quoted: message })
            return
        }

        await sock.sendMessage(chatId, { text: '🎵 Searching Spotify...' }, { quoted: message })

        // Construct a Spotify search URL from the query
        // Using format: https://open.spotify.com/search/{query}
        const spotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`

        await sock.sendMessage(chatId, { text: '🎵 Downloading from Spotify...' }, { quoted: message })
        const audioBuffer = await tryTrustbitSpotify(spotifyUrl)
        
        if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error('Spotify audio download failed')
        }

        const fileName = `${query.replace(/[\\/:*?"<>|]/g, '')}.mp3`
        await sock.sendMessage(chatId, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName
        }, { quoted: message })

    } catch (error) {
        console.error('[SPOTIFY] error:', error?.message || error)
        await sock.sendMessage(chatId, { text: 'Failed to fetch Spotify audio. Try another query later.' }, { quoted: message })
    }
}

module.exports = spotifyCommand;
