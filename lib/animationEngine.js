function buildMenuTemplate({ title, body, footer, buttons, useAnimation = true }) {
  const opener = useAnimation ? '✨ *MENU LOADING...* ✨\n' : ''
  const rows = buttons.map((button, index) => `\n${index + 1}. ${button.label} - ${button.description || ''}`)
  return `${opener}${title}\n\n${body}\n${rows.join('')}\n\n${footer}`
}

function buildAnimatedMessage({ message, frame = 0 }) {
  const frames = ['⏳', '⚡', '🌟', '✅']
  const current = frames[frame % frames.length]
  return `${current} ${message} ${current}`
}

async function animateMessage(sock, chatId, frames, delayMs = 300, quoted = null) {
  if (!sock || !chatId || !Array.isArray(frames) || frames.length === 0) return null

  try {
    await sock.sendPresenceUpdate?.('composing', chatId).catch(() => {})
  } catch (err) {
    // ignore presence update failures
  }

  if (frames.length === 1) {
    return frames[0]
  }

  const wait = Math.max(120, Number(delayMs) || 300)
  for (let index = 0; index < frames.length; index++) {
    try {
      if (index < frames.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    } catch (err) {
      // ignore timing failures
    }
  }

  return frames[frames.length - 1]
}

module.exports = { buildMenuTemplate, buildAnimatedMessage, animateMessage }
