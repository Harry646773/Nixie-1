const axios = require('axios')

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

// ────────────────────────────────────────────────────────
// MISC ENGINE - Utilities & Text Effects System
// ────────────────────────────────────────────────────────

const TEXT_EFFECT_STYLES = [
  'heart', 'circle', 'lgbt', 'tweet', 'namecard', 'jail',
  'glass', 'triggered', 'comrade', 'passed', 'gay', 'horny', 'lolice'
]

const UTILITY_TYPES = [
  'qr', 'barcode', 'shorten', 'expand', 'ip', 'joke2',
  'advice', 'cat', 'dog', 'meme2', 'wikipedia', 'urban'
]

function MISC_LOG(type, result, status, source = 'API') {
  const msg = `╭━━〔 ⚡ MISC LOG 〕━━⬣
┃ Type: ${type}
┃ Status: ${status}
┃ Source: ${source}
╰━━━━━━━━━━━━⬣`
  console.log(msg)
}

/**
 * Generate text effect image
 */
async function generateTextEffect(effect, text, retries = 1) {
  const apis = [
    `https://textpro.me/api/effect/${effect}?text=${encodeURIComponent(text)}`,
    `https://image.pollinations.ai/prompt/${encodeURIComponent(`${effect} text effect with "${text}"`)}`
  ]

  for (let i = 0; i < apis.length; i++) {
    try {
      const response = await axios.get(apis[i], {
        timeout: 20000,
        responseType: 'arraybuffer',
        headers: DEFAULT_HEADERS
      })
      if (response.data && response.data.length > 0) {
        MISC_LOG(effect, 'Image generated', 'SUCCESS', `API #${i + 1}`)
        return { success: true, buffer: Buffer.from(response.data) }
      }
    } catch (e) {
      if (i === apis.length - 1 && retries > 0) {
        await new Promise(r => setTimeout(r, 1000))
        return generateTextEffect(effect, text, retries - 1)
      }
    }
  }

  MISC_LOG(effect, 'Failed', 'ERROR', 'All APIs')
  return { success: false }
}

/**
 * Generate QR Code
 */
async function generateQRCode(text, retries = 1) {
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`
    const response = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' })

    if (response.data && response.data.length > 0) {
      MISC_LOG('qr', 'QR generated', 'SUCCESS', 'qrserver')
      return { success: true, buffer: Buffer.from(response.data) }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return generateQRCode(text, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Generate Barcode
 */
async function generateBarcode(text, retries = 1) {
  try {
    const url = `https://bwipjs-api.metafloor.com/?bcid=code128&text=${encodeURIComponent(text)}&scale=2&height=10`
    const response = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' })

    if (response.data && response.data.length > 0) {
      MISC_LOG('barcode', 'Barcode generated', 'SUCCESS', 'bwipjs')
      return { success: true, buffer: Buffer.from(response.data) }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return generateBarcode(text, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Shorten URL
 */
async function shortenURL(url, retries = 1) {
  const apis = [
    `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
    `https://is.gd/?format=json&longurl=${encodeURIComponent(url)}`
  ]

  for (let i = 0; i < apis.length; i++) {
    try {
      const response = await axios.get(apis[i], { timeout: 10000, headers: DEFAULT_HEADERS })
      let shortUrl = null

      if (i === 0 && response.data) shortUrl = response.data
      if (i === 1 && response.data?.shorturl) shortUrl = response.data.shorturl

      if (shortUrl) {
        MISC_LOG('shorten', shortUrl, 'SUCCESS', `API #${i + 1}`)
        return { success: true, result: shortUrl }
      }
    } catch (e) {
      if (i === apis.length - 1 && retries > 0) {
        await new Promise(r => setTimeout(r, 800))
        return shortenURL(url, retries - 1)
      }
    }
  }

  return { success: false }
}

/**
 * Expand shortened URL
 */
async function expandURL(shortUrl, retries = 1) {
  try {
    const response = await axios.head(shortUrl, { timeout: 10000, maxRedirects: 1, headers: DEFAULT_HEADERS })
    const expanded = response.request?.res?.responseUrl || response.config.url

    if (expanded) {
      MISC_LOG('expand', expanded, 'SUCCESS', 'redirect')
      return { success: true, result: expanded }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return expandURL(shortUrl, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get IP Information
 */
async function getIPInfo(retries = 1) {
  try {
    const response = await axios.get('https://ipinfo.io/json', { timeout: 10000 })

    if (response.data) {
      const { ip, city, region, country, org } = response.data
      MISC_LOG('ip', `${ip} (${country})`, 'SUCCESS', 'ipinfo')
      return { success: true, result: { ip, city, region, country, org } }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getIPInfo(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Random Joke
 */
async function getJoke(retries = 1) {
  try {
    const response = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 10000 })

    if (response.data?.setup && response.data?.punchline) {
      const joke = `${response.data.setup}\n\n${response.data.punchline}`
      MISC_LOG('joke2', joke.substring(0, 30), 'SUCCESS', 'joke-api')
      return { success: true, result: joke }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getJoke(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Random Advice
 */
async function getAdvice(retries = 1) {
  try {
    const response = await axios.get('https://api.adviceslip.com/advice', { timeout: 10000 })

    if (response.data?.slip?.advice) {
      MISC_LOG('advice', response.data.slip.advice.substring(0, 30), 'SUCCESS', 'adviceslip')
      return { success: true, result: response.data.slip.advice }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getAdvice(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Cat Image
 */
async function getCatImage(retries = 1) {
  try {
    const response = await axios.get('https://api.thecatapi.com/v1/images/search', { timeout: 10000 })

    if (response.data?.[0]?.url) {
      MISC_LOG('cat', 'Image fetched', 'SUCCESS', 'thecatapi')
      return { success: true, url: response.data[0].url }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getCatImage(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Dog Image
 */
async function getDogImage(retries = 1) {
  try {
    const response = await axios.get('https://dog.ceo/api/breeds/image/random', { timeout: 10000 })

    if (response.data?.status === 'success' && response.data?.message) {
      MISC_LOG('dog', 'Image fetched', 'SUCCESS', 'dog.ceo')
      return { success: true, url: response.data.message }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getDogImage(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Get Random Meme
 */
async function getMeme(retries = 1) {
  try {
    const response = await axios.get('https://api.imgflip.com/get_memes', { timeout: 10000 })

    if (response.data?.data?.memes && response.data.data.memes.length > 0) {
      const meme = response.data.data.memes[Math.floor(Math.random() * response.data.data.memes.length)]
      MISC_LOG('meme2', meme.name.substring(0, 30), 'SUCCESS', 'imgflip')
      return { success: true, url: meme.url, name: meme.name }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return getMeme(retries - 1)
    }
  }

  return { success: false }
}

/**
 * Search Wikipedia
 */
async function searchWikipedia(query, retries = 1) {
  if (!query?.trim()) return { success: false }

  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(query)}&redirects=1&formatversion=2`
    const response = await axios.get(url, {
      timeout: 10000,
      headers: DEFAULT_HEADERS
    })

    const page = response.data?.query?.pages?.[0]
    if (page?.extract) {
      const summary = page.extract.substring(0, 500)
      MISC_LOG('wikipedia', query, 'SUCCESS', 'wikipedia')
      return { success: true, result: summary, title: page.title }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return searchWikipedia(query, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Search Urban Dictionary
 */
async function searchUrban(word, retries = 1) {
  try {
    const response = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(word)}`, {
      timeout: 10000
    })

    if (response.data?.list && response.data.list.length > 0) {
      const def = response.data.list[0]
      const meaning = `${def.definition}\n\nExample: ${def.example}`.substring(0, 500)
      MISC_LOG('urban', word, 'SUCCESS', 'urbandictionary')
      return { success: true, result: meaning }
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 800))
      return searchUrban(word, retries - 1)
    }
  }

  return { success: false }
}

/**
 * Main router function
 */
async function processMisc(type, input) {
  if (!type) return null

  const normalizedType = type.toLowerCase().trim()

  // Text Effects
  if (TEXT_EFFECT_STYLES.includes(normalizedType)) {
    return await generateTextEffect(normalizedType, input)
  }

  // Utilities
  switch (normalizedType) {
    case 'qr':
      return await generateQRCode(input)
    case 'barcode':
      return await generateBarcode(input)
    case 'shorten':
      return await shortenURL(input)
    case 'expand':
      return await expandURL(input)
    case 'ip':
      return await getIPInfo()
    case 'joke2':
      return await getJoke()
    case 'advice':
      return await getAdvice()
    case 'cat':
      return await getCatImage()
    case 'dog':
      return await getDogImage()
    case 'meme2':
      return await getMeme()
    case 'wikipedia':
      return await searchWikipedia(input)
    case 'urban':
      return await searchUrban(input)
    default:
      return null
  }
}

/**
 * Get supported misc types
 */
function getSupportedMiscTypes() {
  return {
    textEffects: TEXT_EFFECT_STYLES,
    utilities: UTILITY_TYPES,
    total: TEXT_EFFECT_STYLES.length + UTILITY_TYPES.length
  }
}

module.exports = {
  processMisc,
  getSupportedMiscTypes,
  TEXT_EFFECT_STYLES,
  UTILITY_TYPES
}
