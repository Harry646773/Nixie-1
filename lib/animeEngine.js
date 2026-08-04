async function processAnime(sock, chatId, command, args, reply) {
  await reply(`Anime command ${command} is not configured yet.`)
}

function getSupportedAnimeTypes() {
  return ['waifu', 'husbando', 'neko']
}

module.exports = { processAnime, getSupportedAnimeTypes }
