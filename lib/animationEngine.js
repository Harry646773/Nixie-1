const { setTimeout: delay } = require('timers/promises')

async function animateMessage(sock, chatId, frames, speed = 300, quoted = null) {
  if (!Array.isArray(frames) || frames.length === 0) return null
  const normalized = frames.map(frame => typeof frame === 'string' ? frame : String(frame))
  const initialOptions = quoted ? { quoted } : {}

  let message
  try {
    message = await sock.sendMessage(chatId, { text: normalized[0] }, initialOptions)
  } catch (err) {
    return null
  }

  if (!message?.key?.id) return null
  const key = message.key
  let fallback = false

  ;(async () => {
    for (let i = 1; i < normalized.length; i++) {
      await delay(speed)
      const frame = normalized[i]
      if (!fallback) {
        try {
          await sock.sendMessage(chatId, { text: frame }, { edit: key })
          continue
        } catch (err) {
          fallback = true
        }
      }

      try {
        await sock.sendMessage(chatId, { text: frame })
      } catch (err) {
        continue
      }
    }
  })().catch(() => {})

  return message
}

module.exports = {
  animateMessage,
}
