async function handleAntiBot(sock, messageUpdate, chatId, senderId) {
  return
}
async function handleAntiSticker(sock, chatId, senderId, message) {
  return
}
async function handleAntiBadword(sock, chatId, senderId, text) {
  return
}
async function handleAntiGroupStatus(sock, id, action, participant) {
  return
}
async function handleAntiLink(sock, chatId, senderId, text, message) {
  return
}
async function handleAntiSpam(sock, chatId, senderId, text) {
  return
}
async function handleAction(action, payload) {
  // Best-effort guard action stub. Real delete actions require a socket reference.
  return
}
async function toggleFeature(key, enabled) {
  return { key, enabled }
}
async function storeMessageForGuard(chatId, message) {
  return
}

module.exports = {
  handleAntiBot,
  handleAntiSticker,
  handleAntiBadword,
  handleAntiGroupStatus,
  handleAntiLink,
  handleAntiSpam,
  handleAction,
  toggleFeature,
  storeMessageForGuard,
}
