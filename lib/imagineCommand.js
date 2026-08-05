"use strict"

const axios = require('axios')

/**
 * imagineCommand(sock, message, chatId, fullArgs, reply)
 * Uses Trustbit only for image generation.
 */
const TRUSTBIT_API_BASE = process.env.TRUSTBIT_API_BASE || 'https://trustbit-api-devtrust.onrender.com/api'

/**
 * imagineCommand(sock, message, chatId, fullArgs, reply)
 * Uses Trustbit only for image generation.
 */
async function imagineCommand(sock, message, chatId, fullArgs, reply) {
  try {
    const promptRaw = (fullArgs || '').trim()
    if (!promptRaw) {
      await reply(`╭━━〔 IMAGINE AI 〕━━⬣\n┃ Example:\n┃ .imagine futuristic cyberpunk city\n┃ .imagine anime girl in rain\n╰━━━━━━━━━━━━⬣`)
      return
    }

    try {
      await sock.sendMessage(chatId, { text: '🎨 Generating your image...' }, { quoted: message })
    } catch (e) { }

    const enhancers = [
      'masterpiece',
      'ultra realistic',
      'cinematic lighting',
      'highly detailed',
      '4k',
      'professional photography',
      'sharp focus'
    ]

    const pickCount = 3 + Math.floor(Math.random() * 2)
    const shuffled = enhancers.sort(() => 0.5 - Math.random())
    const chosen = shuffled.slice(0, pickCount)
    const finalPrompt = `${promptRaw} — ${chosen.join(', ')}`

    const apiUrl = `${TRUSTBIT_API_BASE}/ai/aiappgen?prompt=${encodeURIComponent(finalPrompt)}`
    const res = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 60_000 })
    const imageBuffer = res?.data ? Buffer.from(res.data) : null

    if (!imageBuffer || imageBuffer.length === 0) {
      console.error('imagineCommand trustbit failed', res?.status, res?.headers)
      await reply('❌ Failed to generate image. Please try again later.')
      return
    }

    try {
      await sock.sendMessage(chatId, { image: imageBuffer, caption: '🎨 Generated Image' }, { quoted: message })
    } catch (err) {
      console.error('imagine send failed:', err?.message || err)
      await reply('❌ Failed to send generated image. Please try again later.')
    }
  } catch (err) {
    console.error('imagineCommand error:', err?.message || err)
    try { await reply('❌ Failed to generate image. Please try again later.') } catch {}
  }
}

module.exports = imagineCommand
