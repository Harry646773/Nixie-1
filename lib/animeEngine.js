const axios = require('axios')

// ────────────────────────────────────────────────────────
// ANIME ENGINE - Anime Actions & Info System
// ────────────────────────────────────────────────────────

const ANIME_ACTIONS = [
  'hug', 'kiss', 'pat', 'cry', 'wink', 'poke', 'nom', 'facepalm'
]

const ANIME_INFO_TYPES = [
  'anime', 'manga', 'character', 'waifu', 'husbando',
  'neko', 'foxgirl', 'animequote', 'animenews',
  'topanime', 'topmanga', 'seasonal'
]

function ANIME_LOG(type, result, status, source = 'API') {
  const msg = `╭━━〔 🎌 ANIME LOG 〕━━⬣
┃ Type: ${type}
┃ Status: ${status}
┃ Source: ${source}
╰━━━━━━━━━━━━⬣`
  console.log(msg)
}

/**
 * Get anime action GIF (hug, kiss, pat, etc.)
 */
async function getAnimeAction(action, retries = 1) {
  const endpoints = {
    hug: 'https://waifu.pics/api/sfw/hug',
    kiss: 'https://waifu.pics/api/sfw/kiss',
    pat: 'https://waifu.pics/api/sfw/pat',
    cry: 'https://waifu.pics/api/sfw/cry',
    wink: 'https://waifu.pics/api/sfw/wink',
    poke: 'https://waifu.pics/api/sfw/poke',
    nom: 'https://waifu.pics/api/sfw/nom',
    facepalm: 'https://waifu.pics/api/sfw/facepalm'
  }

  const url = endpoints[action]
  if (!url) return { success: false }

  // Fallback endpoint
  const fallbackUrl = `https://api.nekos.life/v2/img/${action}`

  for (let i = 0; i < 2; i++) {
    try {
      const apiUrl = i === 0 ? url : fallbackUrl
      const response = await axios.get(apiUrl, { timeout: 10000 })

      if (response.data?.url) {
        ANIME_LOG(action, 'GIF fetched', 'SUCCESS', i === 0 ? 'waifu.pics' : 'nekos.life')
        return { success: true, url: response.data.url }
      }
    } catch (e) {
      if (i === 1 && retries > 0) {
        await new Promise(r => setTimeout(r, 800))
        return getAnimeAction(action, retries - 1)
      }
    }
  }

  ANIME_LOG(action, 'Failed', 'ERROR', 'All APIs')
  return { success: false }
}

/**
 * Search Anime (Jikan API)
 */
async function searchAnime(query, retries = 1) {
  try {
    const response = await axios.get(`https://api.jikan.moe/v4/anime?query=${encodeURIComponent(query)}&limit=1`, {
      timeout: 15000
    })

    if (response.data?.data && response.data.data.length > 0) {
      const anime = response.data.data[0]
      const result = {
        title: anime.title,
        episodes: anime.episodes,
        status: anime.status,
        score: anime.score,
        genre: anime.genres?.map(g => g.name).join(', ') || 'N/A',
        image: anime.images?.jpg?.image_url,
        synopsis: anime.synopsis?.substring(0, 300) || 'N/A'
      }
      ANIME_LOG('anime', anime.title, 'SUCCESS', 'Jikan')
      return { success: true, result }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return searchAnime(query, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Search Manga (Jikan API)
 */
async function searchManga(query, retries = 1) {
  try {
    const response = await axios.get(`https://api.jikan.moe/v4/manga?query=${encodeURIComponent(query)}&limit=1`, {
      timeout: 15000
    })

    if (response.data?.data && response.data.data.length > 0) {
      const manga = response.data.data[0]
      const result = {
        title: manga.title,
        chapters: manga.chapters,
        status: manga.status,
        score: manga.score,
        genre: manga.genres?.map(g => g.name).join(', ') || 'N/A',
        image: manga.images?.jpg?.image_url,
        synopsis: manga.synopsis?.substring(0, 300) || 'N/A'
      }
      ANIME_LOG('manga', manga.title, 'SUCCESS', 'Jikan')
      return { success: true, result }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return searchManga(query, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Search Character (Jikan API)
 */
async function searchCharacter(query, retries = 1) {
  try {
    const response = await axios.get(`https://api.jikan.moe/v4/characters?query=${encodeURIComponent(query)}&limit=1`, {
      timeout: 15000
    })

    if (response.data?.data && response.data.data.length > 0) {
      const char = response.data.data[0]
      const result = {
        name: char.name,
        name_kanji: char.name_kanji,
        about: char.about?.substring(0, 300) || 'N/A',
        image: char.images?.jpg?.image_url,
        favorites: char.favorites
      }
      ANIME_LOG('character', char.name, 'SUCCESS', 'Jikan')
      return { success: true, result }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return searchCharacter(query, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Random Waifu
 */
async function getRandomWaifu(retries = 1) {
  try {
    const response = await axios.get('https://waifu.pics/api/sfw/waifu', { timeout: 10000 })

    if (response.data?.url) {
      ANIME_LOG('waifu', 'Image fetched', 'SUCCESS', 'waifu.pics')
      return { success: true, url: response.data.url }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getRandomWaifu(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Random Husbando
 */
async function getRandomHusbando(retries = 1) {
  try {
    const response = await axios.get('https://waifu.pics/api/sfw/husbando', { timeout: 10000 })

    if (response.data?.url) {
      ANIME_LOG('husbando', 'Image fetched', 'SUCCESS', 'waifu.pics')
      return { success: true, url: response.data.url }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getRandomHusbando(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Neko Image
 */
async function getNeko(retries = 1) {
  try {
    const response = await axios.get('https://api.nekos.life/v2/img/neko', { timeout: 10000 })

    if (response.data?.url) {
      ANIME_LOG('neko', 'Image fetched', 'SUCCESS', 'nekos.life')
      return { success: true, url: response.data.url }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getNeko(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Foxgirl Image
 */
async function getFoxgirl(retries = 1) {
  try {
    const response = await axios.get('https://api.nekos.life/v2/img/fox_girl', { timeout: 10000 })

    if (response.data?.url) {
      ANIME_LOG('foxgirl', 'Image fetched', 'SUCCESS', 'nekos.life')
      return { success: true, url: response.data.url }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getFoxgirl(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Anime Quote
 */
async function getAnimeQuote(retries = 1) {
  try {
    const response = await axios.get('https://animechan.io/api/v1/quotes/random', { timeout: 10000 })

    if (response.data?.quote && response.data?.character) {
      const quote = `"${response.data.quote}"\n\n— ${response.data.character} (${response.data.anime})`
      ANIME_LOG('animequote', 'Quote fetched', 'SUCCESS', 'animechan')
      return { success: true, result: quote }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getAnimeQuote(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Anime News
 */
async function getAnimeNews(retries = 1) {
  try {
    const response = await axios.get('https://api.jikan.moe/v4/news', { timeout: 15000 })

    if (response.data?.data && response.data.data.length > 0) {
      const news = response.data.data[0]
      const result = {
        title: news.title,
        excerpt: news.excerpt?.substring(0, 300),
        date: news.date,
        url: news.url
      }
      ANIME_LOG('animenews', news.title, 'SUCCESS', 'Jikan')
      return { success: true, result }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return getAnimeNews(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Top Anime
 */
async function getTopAnime(retries = 1) {
  try {
    const response = await axios.get('https://api.jikan.moe/v4/top/anime?limit=5', { timeout: 15000 })

    if (response.data?.data && response.data.data.length > 0) {
      const list = response.data.data.map((a, i) => `${i + 1}. ${a.title} (Score: ${a.score})`).join('\n')
      ANIME_LOG('topanime', 'List fetched', 'SUCCESS', 'Jikan')
      return { success: true, result: list }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return getTopAnime(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Top Manga
 */
async function getTopManga(retries = 1) {
  try {
    const response = await axios.get('https://api.jikan.moe/v4/top/manga?limit=5', { timeout: 15000 })

    if (response.data?.data && response.data.data.length > 0) {
      const list = response.data.data.map((m, i) => `${i + 1}. ${m.title} (Score: ${m.score})`).join('\n')
      ANIME_LOG('topmanga', 'List fetched', 'SUCCESS', 'Jikan')
      return { success: true, result: list }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return getTopManga(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Seasonal Anime
 */
async function getSeasonalAnime(retries = 1) {
  try {
    const response = await axios.get('https://api.jikan.moe/v4/seasons/now?limit=5', { timeout: 15000 })

    if (response.data?.data && response.data.data.length > 0) {
      const list = response.data.data.map((a, i) => `${i + 1}. ${a.title}`).join('\n')
      ANIME_LOG('seasonal', 'List fetched', 'SUCCESS', 'Jikan')
      return { success: true, result: list }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return getSeasonalAnime(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Main router function
 */
async function processAnime(type, input = '') {
  if (!type) return null

  const normalizedType = type.toLowerCase().trim()

  // Anime Actions
  if (ANIME_ACTIONS.includes(normalizedType)) {
    return await getAnimeAction(normalizedType)
  }

  // Anime Info Types
  switch (normalizedType) {
    case 'anime':
      return await searchAnime(input)
    case 'manga':
      return await searchManga(input)
    case 'character':
      return await searchCharacter(input)
    case 'waifu':
      return await getRandomWaifu()
    case 'husbando':
      return await getRandomHusbando()
    case 'neko':
      return await getNeko()
    case 'foxgirl':
      return await getFoxgirl()
    case 'animequote':
      return await getAnimeQuote()
    case 'animenews':
      return await getAnimeNews()
    case 'topanime':
      return await getTopAnime()
    case 'topmanga':
      return await getTopManga()
    case 'seasonal':
      return await getSeasonalAnime()
    default:
      return null
  }
}

/**
 * Get supported anime types
 */
function getSupportedAnimeTypes() {
  return {
    actions: ANIME_ACTIONS,
    info: ANIME_INFO_TYPES,
    total: ANIME_ACTIONS.length + ANIME_INFO_TYPES.length
  }
}

module.exports = {
  processAnime,
  getSupportedAnimeTypes,
  ANIME_ACTIONS,
  ANIME_INFO_TYPES
}
