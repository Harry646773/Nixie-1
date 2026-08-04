async function generateStyledText(text, style) {
  if (!text) return 'No text provided.'
  return `Styled text: ${text}`
}

function getSupportedStyles() {
  return ['default', 'bold', 'italic']
}

module.exports = { generateStyledText, getSupportedStyles }
