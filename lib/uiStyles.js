function applyFont(text, fontName) {
  return `*${fontName || 'default'}*: ${text}`
}

function listFonts() {
  return ['default', 'serif', 'sans', 'monospace']
}

function fontExists(name) {
  return listFonts().includes(name)
}

function previewFont(name, sample = 'Sample Text') {
  return applyFont(sample, name)
}

module.exports = { applyFont, listFonts, fontExists, previewFont }
