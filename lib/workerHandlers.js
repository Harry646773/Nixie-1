"use strict"

const axios = require('axios')
const FormData = require('form-data')
const sharp = require('sharp')
const { webp2mp4 } = require('./webp2mp4')
const { ffmpeg } = require('./converter')
const { runYtDlpWithFallback, chooseBestAudioFormat, chooseBestVideoFormat } = require('./ytDlpHelper')

async function ytmp3Handler({ url, timeoutMs = 180000 }) {
  if (!url || typeof url !== 'string') throw new Error('Invalid URL')
  const args = [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--no-playlist',
    '--no-progress',
    '--quiet',
    '--no-check-certificate',
    '--socket-timeout', '60',
    '--retries', '5',
    '--fragment-retries', '5',
    '-o', '-',
    '--',
    url
  ]
  const buffer = await runYtDlpWithFallback(url, args, 50 * 1024 * 1024, timeoutMs, chooseBestAudioFormat)
  return { type: 'base64', data: buffer.toString('base64') }
}

async function ytmp4Handler({ url, timeoutMs = 180000 }) {
  if (!url || typeof url !== 'string') throw new Error('Invalid URL')
  const args = [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-progress',
    '--quiet',
    '--no-check-certificate',
    '--socket-timeout', '60',
    '--retries', '5',
    '--fragment-retries', '5',
    '-o', '-',
    '--',
    url
  ]
  const buffer = await runYtDlpWithFallback(url, args, 100 * 1024 * 1024, timeoutMs, chooseBestVideoFormat)
  return { type: 'base64', data: buffer.toString('base64') }
}

async function webp2mp4Handler({ imageBase64 }) {
  if (!imageBase64) throw new Error('No image data')
  const buf = Buffer.from(imageBase64, 'base64')
  const converted = await webp2mp4(buf)
  return { type: 'base64', data: Buffer.from(converted).toString('base64') }
}

async function audio2mp4Handler({ audioBase64 }) {
  if (!audioBase64) throw new Error('No audio data')
  const buf = Buffer.from(audioBase64, 'base64')
  const converted = await ffmpeg(buf, ['-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p', '-shortest'], 'mp4', 'audio2mp4')
  return { type: 'base64', data: Buffer.from(converted).toString('base64') }
}

const TRUSTBIT_API_BASE = process.env.TRUSTBIT_API_BASE || 'https://trustbit-api-devtrust.onrender.com/api'

async function imagineHandler({ prompt }) {
  if (!prompt || !prompt.trim()) throw new Error('No prompt')
  const enhancers = [
    'masterpiece','ultra realistic','cinematic lighting','highly detailed','4k','professional photography','sharp focus'
  ]
  const pickCount = 3 + Math.floor(Math.random() * 2)
  const shuffled = enhancers.sort(() => 0.5 - Math.random())
  const chosen = shuffled.slice(0, pickCount)
  const finalPrompt = `${prompt} — ${chosen.join(', ')}`

  const apiUrl = `${TRUSTBIT_API_BASE}/ai/aiappgen?prompt=${encodeURIComponent(finalPrompt)}`
  const res = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 60_000 })
  if (!res || !res.data || !res.data.length) {
    throw new Error('Trustbit image generation failed')
  }
  return { type: 'base64', data: Buffer.from(res.data).toString('base64') }
}

async function blurHandler({ imageBase64 }) {
  if (!imageBase64) throw new Error('No image')
  const buf = Buffer.from(imageBase64, 'base64')
  const out = await sharp(buf).blur(10).toBuffer()
  return { type: 'base64', data: out.toString('base64') }
}

async function removebgHandler({ imageBase64 }) {
  if (!imageBase64) throw new Error('No image')
  const buf = Buffer.from(imageBase64, 'base64')
  const form = new FormData()
  form.append('file', buf, { filename: 'image.jpg', contentType: 'image/jpeg' })
  const upload = await axios.post('https://telegra.ph/upload', form, { headers: form.getHeaders(), timeout: 30000 })
  const imgUrl = 'https://telegra.ph' + (upload.data && upload.data[0] && upload.data[0].src ? upload.data[0].src : '')
  if (!imgUrl) throw new Error('Upload failed')
  const res = await axios.get(`https://api.ryzendesu.vip/api/tools/removebg?url=${encodeURIComponent(imgUrl)}`, { responseType: 'arraybuffer', timeout: 60_000 })
  if (!res || !res.data) throw new Error('removebg failed')
  return { type: 'base64', data: Buffer.from(res.data).toString('base64') }
}

module.exports = {
  imagine: imagineHandler,
  blur: blurHandler,
  removebg: removebgHandler,
  ytmp3: ytmp3Handler,
  ytmp4: ytmp4Handler,
  webp2mp4: webp2mp4Handler,
  audio2mp4: audio2mp4Handler
}
