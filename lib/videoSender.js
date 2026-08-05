const fs = require('fs')
const os = require('os')
const path = require('path')
const { fetchRemoteBuffer } = require('./mediaEngine')

function sanitizeName(name) {
  return String(name || 'video').replace(/[\\/:*?"<>|]+/g, '').substring(0, 120)
}

async function sendVideoPayload(sock, chatId, buffer, meta = {}, message = null) {
  const fileName = (meta && meta.title) ? `${sanitizeName(meta.title).substring(0,60)}.mp4` : 'video.mp4'
  const size = buffer ? buffer.length : 0

  console.log('[videoSender] sendVideoPayload', { chatId, title: meta?.title, size })

  let thumbBuf = null
  try {
    if (meta && meta.thumbnail) thumbBuf = await fetchRemoteBuffer(meta.thumbnail, 64 * 1024)
  } catch (e) {
    console.warn('[videoSender] thumbnail fetch failed', e?.message || e)
    thumbBuf = null
  }

  // Optional debug save
  if (process.env.SAVE_VIDEO_DEBUG === '1') {
    try {
      const tmpDir = path.join(process.cwd(), 'tmp', 'video-debug')
      fs.mkdirSync(tmpDir, { recursive: true })
      const p = path.join(tmpDir, fileName)
      fs.writeFileSync(p, buffer)
      console.log('[videoSender] saved debug video to', p)
    } catch (e) {
      console.warn('[videoSender] debug save failed', e?.message || e)
    }
  }

  try {
    await sock.sendMessage(chatId, { video: buffer, mimetype: 'video/mp4', caption: fileName }, { quoted: message })
  } catch (err) {
    console.error('[videoSender] send video failed, falling back to document:', err?.message || err)
    try {
      await sock.sendMessage(chatId, { document: buffer, mimetype: 'video/mp4', fileName }, { quoted: message })
    } catch (err2) {
      console.error('[videoSender] fallback document send failed:', err2?.message || err2)
      throw err2
    }
    return
  }

  // Send document fallback copy to ensure at least one downloadable artifact
  try {
    await sock.sendMessage(chatId, { document: buffer, mimetype: 'video/mp4', fileName, caption: 'If the video does not play, download this file.' }, { quoted: message })
  } catch (e) {
    console.warn('[videoSender] fallback document send (post-video) failed:', e?.message || e)
  }
}

module.exports = { sendVideoPayload }
