const sharp = require('sharp')
const { spawnSync } = require('child_process')
const { ffmpeg } = require('./converter')

function isAnimatedStickerSupported() {
  try {
    const proc = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' })
    if (proc.status === 0 && proc.stdout) return true
  } catch (e) {
    // ignore
  }
  try {
    require('ffmpeg-static')
    return true
  } catch (e) {}
  try {
    require('@ffmpeg-installer/ffmpeg')
    return true
  } catch (e) {}
  return false
}

async function imageToSticker(buffer) {
  // convert image buffer to webp sticker-sized buffer
  const out = await sharp(buffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 100 })
    .toBuffer()
  return out
}

async function videoToAnimatedSticker(buffer, durationSec = 6) {
  if (!isAnimatedStickerSupported()) throw new Error('ANIMATED_STICKERS_NOT_INSTALLED')
  // Use ffmpeg to convert to animated webp suitable for WhatsApp stickers
  const args = [
    '-vf',
    'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15',
    '-loop', '0',
    '-ss', '0',
    '-t', String(durationSec),
    '-vcodec', 'libwebp',
    '-lossless', '0',
    '-qscale', '75',
    '-preset', 'default',
    '-an',
    '-vsync', '0'
  ]
  const out = await ffmpeg(buffer, args, 'webp', 'sticker')
  return out
}

module.exports = { imageToSticker, videoToAnimatedSticker, isAnimatedStickerSupported }
