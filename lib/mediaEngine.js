// ════════════════════════════════════════════════════════════════════
// NIXIE MEDIA ENGINE - TRUSTBIT FIRST, BUFFER-ONLY, FLY.IO READY
// ════════════════════════════════════════════════════════════════════

const axios = require('axios')
const yts = require('yt-search')
const ytdl = require('ytdl-core')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const { URL } = require('url')
const { cacheManager } = require('./cacheManager')
const { queueManager } = require('./queueManager')
const workerPool = require('./workerPool')
const { hasYtDlp, getYtDlpBinary, runYtDlpWithFallback, chooseBestAudioFormat, chooseBestVideoFormat, fetchRemoteBuffer } = require('./ytDlpHelper')

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'

const MAX_AUDIO_BYTES = parseInt(process.env.AUDIO_BUFFER_MAX_BYTES || '50000000', 10)
const MAX_VIDEO_BYTES = parseInt(process.env.VIDEO_BUFFER_MAX_BYTES || '100000000', 10)
const YTDLP_TIMEOUT_MS = parseInt(process.env.YTDLP_TIMEOUT_MS || '180000', 10)
const YTDLP_RETRY_TIMEOUT_MS = parseInt(process.env.YTDLP_RETRY_TIMEOUT_MS || '300000', 10)

function log(stage, status, details = '') {
  try {
    if (details && typeof details === 'object') details = JSON.stringify(details)
    console.log(`[mediaEngine] [${stage}] ${status}` + (details ? ` - ${details}` : ''))
  } catch (e) {}
}

async function tryTrustbitDownload(origUrl, isAudio = true) {
  if (!origUrl) return null
  const enc = encodeURIComponent(origUrl)
  const API_BASE = 'https://trustbit-api-devtrust.onrender.com/api/download'
  const candidates = []

  // Add Trustbit endpoints based on URL type
  if (/(?:youtube\.com|youtu\.be)/i.test(origUrl)) {
    if (isAudio) {
      candidates.push(`${API_BASE}/youtube-audio?url=${enc}`)
      candidates.push(`${API_BASE}/youtube-video?url=${enc}`)
    } else {
      candidates.push(`${API_BASE}/youtube-video?url=${enc}`)
      candidates.push(`${API_BASE}/youtube-audio?url=${enc}`)
    }
  }

  if (/tiktok/i.test(origUrl)) {
    candidates.push(`${API_BASE}/tiktok?url=${enc}`)
    candidates.push(`${API_BASE}/tiktokvideo?url=${enc}`)
  }

  if (/twitter|x\.com/i.test(origUrl)) {
    candidates.push(`${API_BASE}/twitter?url=${enc}`)
  }

  if (/spotify\.com/i.test(origUrl)) {
    candidates.push(`${API_BASE}/spotifyv2?url=${enc}`)
    candidates.push(`${API_BASE}/spotify?url=${enc}`)
  }

  if (/pinterest/i.test(origUrl)) {
    candidates.push(`${API_BASE}/pinterest?url=${enc}`)
  }

  if (/facebook\.com/i.test(origUrl)) {
    candidates.push(`${API_BASE}/facebookv2?url=${enc}`)
    candidates.push(`${API_BASE}/facebook?url=${enc}`)
  }

  if (/instagram\.com/i.test(origUrl)) {
    candidates.push(`${API_BASE}/ig2?url=${enc}`)
    candidates.push(`${API_BASE}/instagram?url=${enc}`)
  }

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

  const isValidTrustbitUrl = (url) => {
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

      if (statusCode === 410) {
        log('trustbit', 'SKIP 410', ep)
        continue
      }

      if (!statusCode || statusCode >= 400) {
        log('trustbit', `HTTP ${statusCode}`, ep)
        continue
      }

      let dl = null
      if (typeof body.download_url === 'string') dl = body.download_url
      else if (body.data && typeof body.data === 'object') {
        dl = body.data.download_url || body.data.url || body.data.play || body.data.hdplay
        if (!dl && Array.isArray(body.data.download_links)) dl = body.data.download_links[0]
        if (!dl) dl = extractUrlFromObject(body.data)
      } else if (typeof body.url === 'string') dl = body.url

      if (!dl) {
        log('trustbit', 'NO DOWNLOAD_URL', ep)
        continue
      }

      if (typeof dl === 'string') {
        dl = dl.replace(/undefined+$/i, '')
        if (!/^https?:\/\//i.test(dl)) {
          if (/^[\w.-]+\//.test(dl) || /^[\w.-]+\./.test(dl)) dl = 'https://' + dl
        }
        if (!isValidTrustbitUrl(dl)) {
          log('trustbit', 'INVALID URL', dl)
          continue
        }
        try {
          const buf = await fetchRemoteBuffer(dl, isAudio ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES, 30000)
          if (buf) {
            log('trustbit', 'SUCCESS', ep)
            return buf
          }
        } catch (err) {
          log('trustbit', 'FETCH FAIL', `${ep}: ${err.message}`)
        }
      }
    } catch (err) {
      log('trustbit', 'ENDPOINT FAIL', `${ep}: ${err.message}`)
    }
  }

  return null
}

async function downloadAudioFallback(url) {
  if (isYouTubeUrl(url)) {
    try {
      const info = await ytdl.getBasicInfo(url, {
        requestOptions: {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
          },
          maxRedirects: 5,
        }
      })
      let audioFormat = chooseBestAudioFormat(info.formats)
      if (!audioFormat) {
        const audioFormats = ytdl.filterFormats(info.formats, 'audioonly')
          .filter((f) => f && f.url)
          .sort((a, b) => (b.bitrate || b.abr || 0) - (a.bitrate || a.abr || 0))
        audioFormat = audioFormats[0] || null
      }
      if (audioFormat && audioFormat.url) {
        const stream = ytdl.downloadFromInfo(info, {
          format: audioFormat,
          requestOptions: {
            headers: { 'User-Agent': DEFAULT_USER_AGENT },
            maxRedirects: 5,
          },
        })
        const buffer = await streamToBuffer(stream, MAX_AUDIO_BYTES)
        if (buffer) {
          log('.ytmp3', 'YTDL SUCCESS', url)
          return buffer
        }
      }
    } catch (err) {
      log('.ytmp3', 'YTDL FAIL', err.message)
    }
  }

  try {
    const tb = await tryTrustbitDownload(url, true)
    if (tb) {
      log('.ytmp3', 'TRUSTBIT SUCCESS', url)
      return tb
    }
  } catch (e) {
    log('.ytmp3', 'TRUSTBIT FAIL', `${url}: ${e.message}`)
  }

  return null
}

async function downloadVideoFallback(url) {
  if (isYouTubeUrl(url)) {
    try {
      const info = await ytdl.getBasicInfo(url, {
        requestOptions: {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
          },
          maxRedirects: 5,
        }
      })
      let videoFormat = chooseBestVideoFormat(info.formats)
      if (!videoFormat) {
        const combinedFormats = ytdl.filterFormats(info.formats, 'audioandvideo').filter((f) => f && f.url)
          .sort((a, b) => ((b.height || 0) - (a.height || 0)) || ((b.bitrate || b.tbr || 0) - (a.bitrate || a.tbr || 0)))
        videoFormat = combinedFormats[0] || null
      }
      if (videoFormat && videoFormat.url) {
        const stream = ytdl.downloadFromInfo(info, {
          format: videoFormat,
          requestOptions: {
            headers: { 'User-Agent': DEFAULT_USER_AGENT },
            maxRedirects: 5,
          },
        })
        const buffer = await streamToBuffer(stream, MAX_VIDEO_BYTES)
        if (buffer) {
          log('.ytmp4', 'YTDL SUCCESS', url)
          return buffer
        }
      }
    } catch (err) {
      log('.ytmp4', 'YTDL FAIL', err.message)
    }
  }

  try {
    const tb = await tryTrustbitDownload(url, false)
    if (tb) {
      log('.ytmp4', 'TRUSTBIT SUCCESS', url)
      return tb
    }
  } catch (e) {
    log('.ytmp4', 'TRUSTBIT FAIL', `${url}: ${e.message}`)
  }

  return null
}

async function searchYouTube(query, retries = 2) {
  if (!query || !query.trim()) return null
  try {
    const cached = cacheManager.getSearch(query)
    if (cached) return cached

    const results = await yts(query)
    const video = results?.videos?.[0]
    if (!video) return null
    const out = {
      title: video.title,
      url: video.url,
      author: video.author?.name || 'Unknown',
      duration: video.duration,
      views: video.views,
      thumbnail: video.thumbnail
    }
    cacheManager.setSearch(query, out)
    return out
  } catch (error) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return searchYouTube(query, retries - 1)
    }
    log('searchYouTube', 'FAIL', error.message)
    return null
  }
}

async function fetchLyrics(query) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return null
  }

  const endpoint = `https://some-random-api.ml/lyrics?title=${encodeURIComponent(query)}`
  try {
    const { data } = await axios.get(endpoint, {
      timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    })

    if (!data || data.error || !data.lyrics) {
      return null
    }

    return {
      title: data.title || query,
      artist: data.author || 'Unknown',
      lyrics: data.lyrics
    }
  } catch (error) {
    log('fetchLyrics', 'FAIL', error.message)
    return null
  }
}

async function downloadYTAudio(url, timeoutMs = YTDLP_TIMEOUT_MS) {
  return retryable(async () => {
    const result = await workerPool.runTask('ytmp3', { url, timeoutMs })
    if (!result || result.type !== 'base64') {
      throw new Error('ytmp3 worker failed')
    }
    return Buffer.from(result.data, 'base64')
  }, 'downloadYTAudio')
}

async function downloadYTVideo(url, timeoutMs = YTDLP_TIMEOUT_MS) {
  return retryable(async () => {
    const result = await workerPool.runTask('ytmp4', { url, timeoutMs })
    if (!result || result.type !== 'base64') {
      throw new Error('ytmp4 worker failed')
    }
    return Buffer.from(result.data, 'base64')
  }, 'downloadYTVideo')
}

async function searchAndDownloadVideo(query) {
  try {
    const result = await searchYouTube(query)
    if (!result || !result.url) return null
    const buffer = await downloadYTVideo(result.url)
    if (!buffer) return null
    return {
      title: result.title,
      author: result.author,
      thumbnail: result.thumbnail,
      buffer
    }
  } catch (error) {
    log('searchAndDownloadVideo', 'FAIL', error.message)
    return null
  }
}

function sanitizeFileName(text) {
  return String(text || 'media').replace(/[\\/:*?"<>|]+/g, '').substring(0, 120)
}

function isYouTubeUrl(url) {
  try {
    return /(?:youtube\.com|youtu\.be)/i.test(String(url))
  } catch {
    return false
  }
}

function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    stream.on('data', (chunk) => {
      total += chunk.length
      if (total > (maxBytes || Infinity)) {
        stream.destroy()
        return reject(new Error('Stream exceeded max bytes'))
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', (err) => reject(err))
  })
}

async function fetchAudioForUser(userId, url) {
  try {
    if (!url) return { success: false, message: 'No URL provided' }

    const cacheKey = `audio:${url}`
    const cached = cacheManager.getBuffer(cacheKey)
    if (cached) {
      log('[CACHE]', 'HIT', url)
      return { success: true, buffer: cached }
    }

    const result = await queueManager.enqueue(userId, async () => {
      let buf = null
      log('[QUEUE]', 'DOWNLOAD', url)

      if (hasYtDlp()) {
        try {
          buf = await downloadYTAudio(url)
          if (buf) {
            cacheManager.setBuffer(cacheKey, buf)
            return { success: true, buffer: buf }
          }
        } catch (err) {
          log('[DOWNLOAD]', 'FAIL', err.message)
          try {
            const buf2 = await downloadYTAudio(url, YTDLP_RETRY_TIMEOUT_MS)
            cacheManager.setBuffer(cacheKey, buf2)
            return { success: true, buffer: buf2 }
          } catch (err2) {
            log('[DOWNLOAD]', 'RETRY FAIL', err2.message)
          }
        }
      } else {
        log('[DOWNLOAD]', 'SKIP', 'yt-dlp unavailable')
      }

      const fb = await downloadAudioFallback(url)
      if (fb) {
        cacheManager.setBuffer(cacheKey, fb)
        return { success: true, buffer: fb, fallback: true }
      }

      return { success: false, message: 'All downloads failed' }
    })

    return result
  } catch (error) {
    log('fetchAudioForUser', 'FAIL', error.message)
    return { success: false, message: error.message }
  }
}

async function fetchVideoForUser(userId, url) {
  try {
    if (!url) return { success: false, message: 'No URL provided' }

    const cacheKey = `video:${url}`
    const cached = cacheManager.getBuffer(cacheKey)
    if (cached) {
      log('[CACHE]', 'HIT', url)
      return { success: true, buffer: cached }
    }

    const result = await queueManager.enqueue(userId, async () => {
      let buf = null
      log('[QUEUE]', 'DOWNLOAD', url)

      if (hasYtDlp()) {
        try {
          buf = await downloadYTVideo(url)
          if (buf) {
            cacheManager.setBuffer(cacheKey, buf)
            return { success: true, buffer: buf }
          }
        } catch (err) {
          log('[DOWNLOAD]', 'FAIL', err.message)
          try {
            const buf2 = await downloadYTVideo(url, YTDLP_RETRY_TIMEOUT_MS)
            cacheManager.setBuffer(cacheKey, buf2)
            return { success: true, buffer: buf2 }
          } catch (err2) {
            log('[DOWNLOAD]', 'RETRY FAIL', err2.message)
          }
        }
      } else {
        log('[DOWNLOAD]', 'SKIP', 'yt-dlp unavailable')
      }

      const fb = await downloadVideoFallback(url)
      if (fb) {
        cacheManager.setBuffer(cacheKey, fb)
        return { success: true, buffer: fb, fallback: true }
      }

      return { success: false, message: 'All downloads failed' }
    })

    return result
  } catch (error) {
    log('fetchVideoForUser', 'FAIL', error.message)
    return { success: false, message: error.message }
  }
}

function mediaStatus() {
  return {
    hasYtDlp: hasYtDlp(),
    ytDlpBinary: getYtDlpBinary()
  }
}

module.exports = {
  searchYouTube,
  downloadYTAudio,
  downloadYTVideo,
  fetchLyrics,
  searchAndDownloadVideo,
  fetchRemoteBuffer,
  sanitizeFileName,
  fetchAudioForUser,
  fetchVideoForUser,
  mediaStatus
}
