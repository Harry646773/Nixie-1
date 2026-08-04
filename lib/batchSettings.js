const settings = require('../settings')
const DB = require('./mongoData')

async function loadMessageSettings(botNum, chatId, senderId, isGroup) {
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
  ] = await Promise.all([
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
  ])

  return {
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
}

function invalidateUserCache() {
  return
}

module.exports = { loadMessageSettings, invalidateUserCache }
