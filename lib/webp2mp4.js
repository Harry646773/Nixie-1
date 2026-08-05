const { ffmpeg } = require('./converter')

async function webp2mp4(webpBuffer) {
  if (!webpBuffer) throw new Error('no buffer')
  // Convert webp to mp4 using ffmpeg: produce short looped mp4
  const args = [
    '-loop', '0',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-movflags', '+faststart',
  ]
  // Use libx264 for compatibility
  try {
    const out = await ffmpeg(webpBuffer, [...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '10'], 'mp4', 'webp2mp4')
    return out
  } catch (e) {
    // Fallback: simple conversion without codec flags
    return await ffmpeg(webpBuffer, args, 'mp4', 'webp2mp4')
  }
}

module.exports = { webp2mp4 }
