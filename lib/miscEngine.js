async function processMisc(sock, chatId, command, args, reply) {
  await reply(`Misc command ${command} is not implemented yet.`)
}

function getSupportedMiscTypes() {
  return ['echo', 'reverse', 'uppercase']
}

module.exports = { processMisc, getSupportedMiscTypes }
