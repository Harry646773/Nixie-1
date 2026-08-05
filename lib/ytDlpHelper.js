"use strict"

const { spawn, spawnSync } = require('child_process')
const axios = require('axios')

let _ytDlpBinary = null
let _ytDlpBinaryArgs = []

function resolveYtDlpBinary() {
  if (_ytDlpBinary !== null) return Boolean(_ytDlpBinary)

  const candidates = [
    { cmd: 'yt-dlp', args: [] },
    { cmd: 'python3', args: ['-m', 'yt_dlp'] },
    { cmd: 'python', args: ['-m', 'yt_dlp'] }
  ]

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate.cmd, [...candidate.args, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000
      })
      if (result.status === 0 && result.stdout) {
        _ytDlpBinary = candidate.cmd
        _ytDlpBinaryArgs = candidate.args
        return true
      }
    } catch {
      // ignore
    }
  }

  _ytDlpBinary = false
  return false
}

function buildYtDlpArgs(args) {
  if (!resolveYtDlpBinary()) {
    throw new Error('yt-dlp binary unavailable')
  }
  return [..._ytDlpBinaryArgs, ...args]
}

function runYtDlpToBuffer(args, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!resolveYtDlpBinary()) {
      return reject(new Error('yt-dlp binary unavailable'))
    }

    const child = spawn(_ytDlpBinary, buildYtDlpArgs(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })

    const chunks = []
    let size = 0
    let stderr = ''
    let completed = false

    const timer = setTimeout(() => {
      if (completed) return
      completed = true
      child.kill('SIGKILL')
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (completed) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) {
        completed = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        return reject(new Error(`yt-dlp output exceeded ${maxBytes} bytes`))
      }
      chunks.push(buffer)
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    child.on('error', (error) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code, signal) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited ${code}${signal ? ` signal ${signal}` : ''}: ${stderr.trim()}`))
      }
      resolve(Buffer.concat(chunks))
    })
  })
}

async function extractYtDlpJson(url, timeoutMs = 30000) {
  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-progress',
    '--quiet',
    '--no-check-certificate',
    '--socket-timeout', '30',
    '--retries', '2',
    '--fragment-retries', '2',
    '--',
    url
  ]
  const buffer = await runYtDlpToBuffer(args, 10 * 1024 * 1024, timeoutMs)
  return JSON.parse(buffer.toString('utf8').trim())
}

function chooseBestAudioFormat(formats) {
  if (!Array.isArray(formats)) return null
  return formats
    .filter((format) => format.acodec && format.acodec !== 'none' && format.vcodec === 'none' && String(format.protocol || '').startsWith('http'))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))
    .shift() || null
}

function chooseBestVideoFormat(formats) {
  if (!Array.isArray(formats)) return null
  return formats
    .filter((format) => format.acodec && format.acodec !== 'none' && format.vcodec && format.vcodec !== 'none' && String(format.protocol || '').startsWith('http'))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))
    .shift() || null
}

async function fetchRemoteBuffer(url, maxBytes, timeoutMs, headers = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxRedirects: 5,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: '*/*',
      ...headers
    }
  })
  const buffer = Buffer.from(response.data)
  if (!buffer || buffer.length === 0 || buffer.length > maxBytes) {
    throw new Error(`remote file invalid ${buffer ? buffer.length : 0} bytes`)
  }
  return buffer
}

async function runYtDlpWithFallback(url, args, maxBytes, timeoutMs, chooseFormat) {
  try {
    return await runYtDlpToBuffer(args, maxBytes, timeoutMs)
  } catch (primaryError) {
    try {
      const info = await extractYtDlpJson(url, Math.min(timeoutMs, 20000))
      const format = chooseFormat(info.formats)
      if (format && format.url) {
        return await fetchRemoteBuffer(format.url, maxBytes, timeoutMs, format.http_headers || {})
      }
    } catch {
      // ignore extraction fallback failure
    }
    throw primaryError
  }
}

function hasYtDlp() {
  return resolveYtDlpBinary()
}

function getYtDlpBinary() {
  return _ytDlpBinary || null
}

module.exports = {
  hasYtDlp,
  getYtDlpBinary,
  runYtDlpWithFallback,
  chooseBestAudioFormat,
  chooseBestVideoFormat,
  extractYtDlpJson,
  fetchRemoteBuffer,
  runYtDlpToBuffer
}
