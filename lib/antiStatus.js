async function antistatusCommand(sock, chatId, args, reply) {
  await reply('Antistatus command is not configured yet.')
}

async function checkStatusForViolations(sock, message) {
  return
}

async function checkMessageForViolations(sock, message) {
  return
}

module.exports = { antistatusCommand, checkStatusForViolations, checkMessageForViolations }
