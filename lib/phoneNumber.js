function getDigitsOnlyPhoneNumber(input) {
  if (input === null || input === undefined) return ''
  return String(input).replace(/\D/g, '')
}

function normalizePhoneNumber(input) {
  const digits = getDigitsOnlyPhoneNumber(input)
  if (!digits) return ''
  return `+${digits}`
}

module.exports = {
  getDigitsOnlyPhoneNumber,
  normalizePhoneNumber,
}
