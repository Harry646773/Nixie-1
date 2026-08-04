const settings = require('../settings')
const DB = require('./mongoData')

const _settingsCache = new Map()
const SETTINGS_CACHE_TTL = 15_000

function _makeCacheKey(botNum, chatId, senderId, isGroup) {
  return `${botNum}:${chatId}:${senderId}:${isGroup ? 'G' : 'P'}`
}

function _cleanupExpired(key) {
  const entry = _settingsCache.get(key)
  if (!entry) return null
  if (entry.exp > Date.now()) return entry
  if (entry.promise) return entry
  _settingsCache.delete(key)
  return null
}

function _getCachedSettings(key) {
  const entry = _cleanupExpired(key)
  if (!entry) return null
  if (entry.value !== undefined) return entry.value
  return entry.promise
}

function _setCachedSettings(key, loader) {
  const existing = _settingsCache.get(key)
  if (existing && existing.promise) return existing.promise

  const promise = (async () => {
    const [
      owners,
      pmBlocker,
      mentionReply,
      autoreply,
      isChatbotOn,
      antidelete,
      antilink,
      antibadword,
      groupAntispam,
      groupAntisticker,
      userPrefix,
      userMode,
      isPublic,
      mutedUsers,
      isWelcomeOn,
      isGoodbyeOn,
      mods,
      autoread,
      autoreact,
      autotyping,
      bannedUsers,
    ] = await loader()

    const value = {
      botState: { isOn: true },
      isPublic,
      owners,
      banned: bannedUsers,
      pmBlocker,
      antidelete,
      antisticker: groupAntisticker || { enabled: false, action: 'delete' },
      antilink,
      antibadword,
      mutedUsers,
      isWelcomeOn,
      isGoodbyeOn,
      isChatbotOn,
      mods,
      autoread,
      autoreact,
      autotyping,
      autoreply,
      mentionReply,
      antispam: groupAntispam || { enabled: false },
      userPrefix,
      userMode,
      animatedResponses: settings.animatedResponses !== false,
      botName: settings.botName || 'NIXIE',
      ownerNumber: settings.ownerNumber,
      owners: owners.length ? owners : [settings.ownerNumber],
    }

    _settingsCache.set(key, { value, exp: Date.now() + SETTINGS_CACHE_TTL })
    return value
  })()

  _settingsCache.set(key, { promise, exp: Date.now() + SETTINGS_CACHE_TTL })
  return promise
}

async function loadMessageSettings(botNum, chatId, senderId, isGroup) {
  const key = _makeCacheKey(botNum, chatId, senderId, isGroup)
  const cached = _getCachedSettings(key)
  if (cached) return cached

  return _setCachedSettings(key, () => Promise.all([
    DB.getOwners(),
    DB.getPmBlocker(botNum),
    DB.getMentionReply(botNum),
    DB.getAutoreply(botNum),
    DB.isChatbotEnabled(chatId),
    DB.getAntidelete(),
    DB.getAntilink(chatId),
    DB.getAntibadword(chatId),
    DB.getGroupSetting(chatId, 'antispam'),
    DB.getGroupSetting(chatId, 'antisticker'),
    DB.getUserSetting(senderId, 'prefix', settings.prefix || '.'),
    DB.getUserSetting(senderId, 'mode', 'strict'),
    DB.getMode(botNum),
    DB.getMutedUsers(chatId),
    DB.isWelcomeEnabled(chatId),
    DB.isGoodbyeEnabled(chatId),
    DB.getMods(chatId),
    DB.getUserSetting(senderId, 'autoread', false),
    DB.getUserSetting(senderId, 'autoreact', false),
    DB.getUserSetting(senderId, 'autotyping', false),
    DB.getBannedUsers(),
  ]))
}

function invalidateUserCache(userId) {
  if (!userId) {
    _settingsCache.clear()
    return
  }

  const search = `:${userId}:`
  for (const key of Array.from(_settingsCache.keys())) {
    if (key.includes(search)) _settingsCache.delete(key)
  }
}

module.exports = { loadMessageSettings, invalidateUserCache }
