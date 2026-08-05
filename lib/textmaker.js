const axios = require('axios')

// ────────────────────────────────────────────────────────
// TEXTMAKER MODULE - Text-to-Image Generation System
// ────────────────────────────────────────────────────────

const TEXTPRO_STYLES = [
  'fire', 'neon', 'glitch', 'matrix', 'ice', 'metal',
  'thunder', 'purple', 'devil', 'sand', 'leaves'
]

const PHOTOOXY_STYLES = [
  'logo', '3d', 'gradient', 'typography', 'art'
]

const TRUSTBIT_STYLES = [
  'fire', 'neon', 'glitch', 'matrix', 'ice', 'metal',
  'thunder', 'purple', 'devil', 'sand', 'leaves',
  'logo', '3d', 'gradient', 'typography', 'art',
  'style1917', 'gradienttext', 'freecreate', 'advancedglow', 'flag3dtext',
  'blackpinklogo', 'blackpinkstyle', 'blackpink', 'cartoonstyle', 'effectclouds', 'deletingtext',
  'glitchtext', 'luxurygold', 'papercutstyle', 'sandsummer', 'summerbeach',
  'underwatertext', 'writetext', 'neonglitch', 'makingneon', 'galaxystyle',
  'lighteffects'
]

const STYLE_PROMPTS = {
  fire: 'flaming text effect, burning letters, fire style, explosive',
  neon: 'neon glowing text, cyberpunk style, bright neon colors',
  glitch: 'glitch effect, digital corruption, RGB split, distorted text',
  matrix: 'matrix code rain effect, green digital text, hacker style',
  ice: 'frozen ice text, crystalline effect, blue frozen letters',
  metal: 'metallic text, shiny metal effect, chrome style',
  thunder: 'lightning bolt effect, electric text, thunderbolt',
  purple: 'purple gradient text, mystical effect, purple flames',
  devil: 'devilish text, demonic effect, red flames, evil style',
  sand: 'sand texture text, desert style, sandy letters',
  leaves: 'leaves effect, nature text, leaf particles around text',
  logo: 'professional logo design, modern text logo',
  '3d': 'stunning 3D text effect, three dimensional letters',
  gradient: 'colorful gradient text, rainbow effect',
  typography: 'artistic typography, beautiful text design',
  art: 'artistic text rendering, creative art style'
}

// Map Trustbit-style command names to exact endpoint names
const TRUSTBIT_STYLE_MAP = {
  // Explicit Trustbit endpoint commands
  neonglitch: 'neonglitch',
  style1917: 'style1917',
  gradienttext: 'gradienttext',
  freecreate: 'freecreate',
  advancedglow: 'advancedglow',
  flag3dtext: 'flag3dtext',
  blackpinklogo: 'blackpinklogo',
  blackpinkstyle: 'blackpinkstyle',
  cartoonstyle: 'cartoonstyle',
  effectclouds: 'effectclouds',
  deletingtext: 'deletingtext',
  glitchtext: 'glitchtext',
  luxurygold: 'luxurygold',
  papercutstyle: 'papercutstyle',
  sandsummer: 'sandsummer',
  summerbeach: 'summerbeach',
  underwatertext: 'underwatertext',
  writetext: 'writetext',
  makingneon: 'makingneon',
  galaxystyle: 'galaxystyle',
  lighteffects: 'lighteffects',

  // Legacy style aliases routed through Trustbit
  neon: 'neonglitch',
  glitch: 'glitchtext',
  gradient: 'gradienttext',
  blackpink: 'blackpinkstyle',
  typography: 'typographytext',
  '3d': 'flag3dtext'
}

function buildTrustbitUrls(style, text) {
  const mapped = TRUSTBIT_STYLE_MAP[style]
  const enc = encodeURIComponent(text)
  const urls = []

  if (mapped) {
    if (mapped === 'freecreate') {
      urls.push(`https://trustbit.app/api/freecreate?style=${encodeURIComponent(style)}&text=${enc}`)
    } else {
      urls.push(`https://trustbit.app/api/${mapped}?text=${enc}`)
      urls.push(`https://trustbit.app/api/${mapped}text?text=${enc}`)
      urls.push(`https://trustbit.app/api/freecreate?style=${encodeURIComponent(style)}&text=${enc}`)
    }
  } else {
    urls.push(`https://trustbit.app/api/freecreate?style=${encodeURIComponent(style)}&text=${enc}`)
  }

  return urls
}

function TEXT_LOG(style, text, status, source = 'N/A') {
  const msg = `╭━━〔 🎨 TEXTMAKER LOG 〕━━⬣
┃ Style: ${style}
┃ Text: ${text.substring(0, 20)}${text.length > 20 ? '...' : ''}
┃ Status: ${status}
┃ Source: ${source}
╰━━━━━━━━━━━━⬣`
  console.log(msg)
}

/**
 * Generate styled text image using TextPro rendering
 * @param {string} style - Text style (fire, neon, glitch, etc.)
 * @param {string} text - Text content
 * @returns {Promise<Buffer>} Image buffer
 */
async function generateTextProStyle(style, text, retries = 1) {
  // Build candidate Trustbit endpoints and fallbacks
  const trustbitCandidates = buildTrustbitUrls(style, text)
  const apiEndpoints = [
    ...trustbitCandidates,
    `https://textpro.me/api/effect/${style}?text=${encodeURIComponent(text)}`,
    `https://api.imgflip.com/text?text=${encodeURIComponent(text)}&effect=${style}`
  ]

  for (let i = 0; i < apiEndpoints.length; i++) {
    const url = apiEndpoints[i]
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        responseType: 'arraybuffer',
        validateStatus: () => true
      })

      const ct = (response.headers && response.headers['content-type']) || ''
      const ok = response.status === 200 && response.data && response.data.length > 0 && ct.startsWith('image')

      if (ok) {
        const src = i < trustbitCandidates.length ? 'Trustbit' : `TextPro API #${i - trustbitCandidates.length + 1}`
        TEXT_LOG(style, text, 'SUCCESS', src + ` (${url})`)
        return Buffer.from(response.data)
      } else {
        TEXT_LOG(style, text, 'SKIPPED', `${url} -> ${response.status} ${ct}`)
      }
    } catch (e) {
      TEXT_LOG(style, text, 'ERROR', `${url} -> ${e.message}`)
      // if last endpoint and we can retry, try again
      if (i === apiEndpoints.length - 1 && retries > 0) {
        await new Promise(r => setTimeout(r, 1000))
        return generateTextProStyle(style, text, retries - 1)
      }
    }
  }

  return null
}

/**
 * Generate styled text image using Photooxy/Canvas rendering
 * @param {string} style - Text style (logo, 3d, gradient, etc.)
 * @param {string} text - Text content
 * @returns {Promise<Buffer>} Image buffer
 */
async function generatePhotooxy(style, text, retries = 1) {
  // Try Trustbit candidates first (some photooxy-like styles are provided by Trustbit)
  const trustbitCandidates = buildTrustbitUrls(style, text)
  const apiEndpoints = [
    ...trustbitCandidates,
    `https://photooxy.com/api/${style}?text=${encodeURIComponent(text)}`,
    `https://canvas.textfx.xyz/api/${style}?text=${encodeURIComponent(text)}`
  ]

  for (let i = 0; i < apiEndpoints.length; i++) {
    const url = apiEndpoints[i]
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        responseType: 'arraybuffer',
        validateStatus: () => true
      })

      const ct = (response.headers && response.headers['content-type']) || ''
      const ok = response.status === 200 && response.data && response.data.length > 0 && ct.startsWith('image')

      if (ok) {
        const src = i < trustbitCandidates.length ? 'Trustbit' : `Photooxy API #${i - trustbitCandidates.length + 1}`
        TEXT_LOG(style, text, 'SUCCESS', src + ` (${url})`)
        return Buffer.from(response.data)
      } else {
        TEXT_LOG(style, text, 'SKIPPED', `${url} -> ${response.status} ${ct}`)
      }
    } catch (e) {
      TEXT_LOG(style, text, 'ERROR', `${url} -> ${e.message}`)
      if (i === apiEndpoints.length - 1 && retries > 0) {
        await new Promise(r => setTimeout(r, 1000))
        return generatePhotooxy(style, text, retries - 1)
      }
    }
  }

  return null
}

async function generateTrustbitStyle(style, text, retries = 1) {
  const apiEndpoints = buildTrustbitUrls(style, text)
  if (!apiEndpoints.length) return null

  for (let i = 0; i < apiEndpoints.length; i++) {
    const url = apiEndpoints[i]
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        responseType: 'arraybuffer',
        validateStatus: () => true
      })

      const ct = (response.headers && response.headers['content-type']) || ''
      const ok = response.status === 200 && response.data && response.data.length > 0 && ct.startsWith('image')

      if (ok) {
        TEXT_LOG(style, text, 'SUCCESS', `Trustbit (${url})`)
        return Buffer.from(response.data)
      } else {
        TEXT_LOG(style, text, 'SKIPPED', `${url} -> ${response.status} ${ct}`)
      }
    } catch (e) {
      TEXT_LOG(style, text, 'ERROR', `${url} -> ${e.message}`)
      if (i === apiEndpoints.length - 1 && retries > 0) {
        await new Promise(r => setTimeout(r, 1000))
        return generateTrustbitStyle(style, text, retries - 1)
      }
    }
  }

  return null
}

/**
 * Fallback: Generate image using Pollinations AI
 * @param {string} style - Text style
 * @param {string} text - Text content
 * @returns {Promise<Buffer>} Image buffer
 */
async function generatePollinationsAIFallback(style, text, retries = 1) {
  const prompt = `${STYLE_PROMPTS[style] || style} with text "${text}" displayed prominently, high quality, professional design`

  try {
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
    const response = await axios.get(imageUrl, {
      timeout: 30000,
      responseType: 'arraybuffer'
    })

    if (response.data && response.data.length > 0) {
      TEXT_LOG(style, text, 'SUCCESS', 'Pollinations AI')
      return Buffer.from(response.data)
    }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1500))
      return generatePollinationsAIFallback(style, text, retries - 1)
    }
    TEXT_LOG(style, text, 'FAILED', 'All APIs exhausted')
  }

  return null
}

/**
 * Main textmaker function - routes to correct API
 * @param {string} style - Text style
 * @param {string} text - Text to render
 * @returns {Promise<Buffer|null>} Image buffer or null
 */
async function generateStyledText(style, text) {
  if (!style || !text) return null

  const normalizedStyle = style.toLowerCase().trim()

  try {
    // Route all styles through Trustbit first. Direct endpoints are used when available,
    // otherwise freecreate handles legacy style names like logo, 3d, gradient, fire, etc.
    let buffer = await generateTrustbitStyle(normalizedStyle, text)
    if (buffer) return buffer

    // Final fallback for any unsupported style
    buffer = await generatePollinationsAIFallback(normalizedStyle, text)
    if (buffer) return buffer

    return null
  } catch (e) {
    console.error('[textmaker] error:', e.message)
    return null
  }
}

/**
 * Get list of supported styles
 * @returns {Object} Grouped styles
 */
function getSupportedStyles() {
  return {
    trustbit: TRUSTBIT_STYLES,
    total: TRUSTBIT_STYLES.length
  }
}

module.exports = {
  generateStyledText,
  getSupportedStyles,
  TEXTPRO_STYLES,
  PHOTOOXY_STYLES,
  TRUSTBIT_STYLES
}
