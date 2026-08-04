async function searchYouTube(query) {
  return { videos: [] }
}

async function downloadYTAudio(url) {
  return { filePath: null }
}

async function downloadYTVideo(url) {
  return { filePath: null }
}

async function fetchLyrics(query) {
  return 'Lyrics unavailable.'
}

async function fetchAudioForUser(userId) {
  return null
}

async function fetchVideoForUser(userId) {
  return null
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[<>:"/\\|?*]+/g, '_')
}

function mediaStatus() {
  return { ready: false }
}

module.exports = { searchYouTube, downloadYTAudio, downloadYTVideo, fetchLyrics, fetchAudioForUser, fetchVideoForUser, sanitizeFileName, mediaStatus }
